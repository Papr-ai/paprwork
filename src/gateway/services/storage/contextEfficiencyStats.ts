import type Database from "better-sqlite3";
import {
  computeCumulativeContextProjection,
  computeTurnFootprintsFast,
} from "./contextFootprintSql.js";
import {
  estimatePartialProjection,
  readCachedLifetimeProjection,
} from "./contextFootprintStore.js";
import {
  ensureContextStatsCacheFresh,
  isContextStatsCacheReady,
} from "./contextStatsCache.js";
import { computeModelAwareCostSavings } from "./contextCostSavings.js";
import { computeMemorySearchSavings } from "./memorySearchSavings.js";
import {
  periodStartIso,
  readBillableTokenTotals,
  sumBillableTokens,
} from "./billableTokens.js";

export type ContextEfficiencyDataSource = "cached" | "partial" | "live";

export interface ContextEfficiencyPeriodStats {
  actualTokens: number;
  hypotheticalTokensWithoutOptimizations: number;
  tokensSaved: number;
  efficiencyScore: number;
}

export interface ContextEfficiencyStats {
  /** Sum across chats: full stored history if sent every turn (naive) */
  fullChatTokensPerTurn: number;
  /** Sum across chats: what loadMessagesForLLM + historyFormatter sends each turn */
  agentContextTokensPerTurn: number;
  truncationTokensSaved: number;
  summaryTokensSaved: number;
  memorySearchTokensSaved: number;
  totalTokensSaved: number;
  /** Billable prompt + completion tokens (lifetime) */
  totalTokensConsumed: number;
  /** Estimated billable tokens if same work ran without Paprwork optimizations */
  hypotheticalTokensWithoutOptimizations: number;
  /** Billable tokens avoided vs hypothetical (lifetime) */
  lifetimeTokensSaved: number;
  /** How much larger cumulative context would have been (naive ÷ optimized) */
  contextInflationRatio: number;
  /** % of hypothetical spend avoided (lifetime) */
  efficiencyScore: number;
  /** Actual API cost from stored message billing */
  actualCost: number;
  /** Estimated cost without Paprwork context optimizations (model-priced) */
  hypotheticalCostWithoutOptimizations: number;
  /** Dollar savings vs hypothetical (model-priced) */
  lifetimeCostSaved: number;
  /** % of hypothetical cost avoided */
  costEfficiencyScore: number;
  /** Whether lifetime totals came from stored per-message footprints */
  dataSource: ContextEfficiencyDataSource;
  /** Billed assistant turns still waiting for footprint backfill */
  pendingFootprintTurns: number;
  /** Period-aligned savings (matches Today / Week / Month columns) */
  periods: {
    today: ContextEfficiencyPeriodStats;
    thisWeek: ContextEfficiencyPeriodStats;
    thisMonth: ContextEfficiencyPeriodStats;
  };
  breakdown: {
    chatsAnalyzed: number;
    chatsWithSummaries: number;
    assistantTurnsAnalyzed: number;
    memorySearchCount: number;
    hybridBashCount: number;
    memoryHitsAnalyzed: number;
    memoryHitsWithSource: number;
    fullReadAvgTokens: number;
    memorySearchAvgTokens: number;
  };
}

const EMPTY_PERIOD: ContextEfficiencyPeriodStats = {
  actualTokens: 0,
  hypotheticalTokensWithoutOptimizations: 0,
  tokensSaved: 0,
  efficiencyScore: 0,
};

export const EMPTY_CONTEXT_EFFICIENCY_STATS: ContextEfficiencyStats = {
  fullChatTokensPerTurn: 0,
  agentContextTokensPerTurn: 0,
  truncationTokensSaved: 0,
  summaryTokensSaved: 0,
  memorySearchTokensSaved: 0,
  totalTokensSaved: 0,
  totalTokensConsumed: 0,
  hypotheticalTokensWithoutOptimizations: 0,
  lifetimeTokensSaved: 0,
  contextInflationRatio: 1,
  efficiencyScore: 0,
  actualCost: 0,
  hypotheticalCostWithoutOptimizations: 0,
  lifetimeCostSaved: 0,
  costEfficiencyScore: 0,
  dataSource: "live",
  pendingFootprintTurns: 0,
  periods: {
    today: { ...EMPTY_PERIOD },
    thisWeek: { ...EMPTY_PERIOD },
    thisMonth: { ...EMPTY_PERIOD },
  },
  breakdown: {
    chatsAnalyzed: 0,
    chatsWithSummaries: 0,
    assistantTurnsAnalyzed: 0,
    memorySearchCount: 0,
    hybridBashCount: 0,
    memoryHitsAnalyzed: 0,
    memoryHitsWithSource: 0,
    fullReadAvgTokens: 0,
    memorySearchAvgTokens: 0,
  },
};

function efficiencyScoreFrom(
  saved: number,
  hypothetical: number,
): number {
  if (hypothetical <= 0) return 0;
  return Math.min(99, Math.round((saved / hypothetical) * 100));
}

interface PeriodProjectionRow {
  prompt_tokens: number;
  completion_tokens: number;
  projected_footprinted: number;
  prompt_footprinted: number;
}

function readPeriodProjectionRow(
  db: Database.Database,
  sinceIso: string,
): PeriodProjectionRow {
  return db
    .prepare(
      `SELECT
         COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
         COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
         COALESCE(SUM(hypothetical_prompt_tokens), 0) AS projected_footprinted,
         COALESCE(
           SUM(
             CASE
               WHEN hypothetical_prompt_tokens IS NOT NULL THEN prompt_tokens
               ELSE 0
             END
           ),
           0
         ) AS prompt_footprinted
       FROM messages
       WHERE role = 'assistant'
         AND prompt_tokens > 0
         AND timestamp >= ?`,
    )
    .get(sinceIso) as PeriodProjectionRow;
}

function computePeriodStats(
  db: Database.Database,
  sinceIso: string,
  inflationRatio: number,
): ContextEfficiencyPeriodStats {
  const row = readPeriodProjectionRow(db, sinceIso);
  const pendingPrompt = Math.max(
    0,
    row.prompt_tokens - row.prompt_footprinted,
  );
  const projectedPromptTokens =
    row.projected_footprinted +
    Math.round(pendingPrompt * Math.max(1, inflationRatio));
  const memory = computeMemorySearchSavings(db, sinceIso);
  const actualTokens = sumBillableTokens(
    row.prompt_tokens,
    row.completion_tokens,
  );
  const hypotheticalTokensWithoutOptimizations =
    projectedPromptTokens + row.completion_tokens + memory.tokensSaved;
  const tokensSaved = Math.max(
    0,
    hypotheticalTokensWithoutOptimizations - actualTokens,
  );

  return {
    actualTokens,
    hypotheticalTokensWithoutOptimizations,
    tokensSaved,
    efficiencyScore: efficiencyScoreFrom(
      tokensSaved,
      hypotheticalTokensWithoutOptimizations,
    ),
  };
}

export function computeContextEfficiencyStats(
  db: Database.Database,
): ContextEfficiencyStats {
  ensureContextStatsCacheFresh(db);

  if (!isContextStatsCacheReady(db)) {
    return {
      ...EMPTY_CONTEXT_EFFICIENCY_STATS,
      dataSource: "partial",
      pendingFootprintTurns: readCachedLifetimeProjection(db).pendingTurns,
    };
  }

  const turnFootprint = computeTurnFootprintsFast(db);
  const memory = computeMemorySearchSavings(db);
  const cached = readCachedLifetimeProjection(db);
  const lifetimeBillable = readBillableTokenTotals(db);

  const measuredPromptTokens = lifetimeBillable.promptTokens;
  const completionTokens = lifetimeBillable.completionTokens;
  const totalTokensConsumed = sumBillableTokens(
    measuredPromptTokens,
    completionTokens,
  );

  let dataSource: ContextEfficiencyDataSource;
  let projectedPromptTokens = cached.projectedPromptTokens;
  let chatsAnalyzed = cached.chatsWithBilling;
  let analyzedAssistantTurns =
    cached.computedTurns + cached.pendingTurns;

  const useFullyCached =
    cached.pendingTurns === 0 && cached.computedTurns > 0;

  if (useFullyCached) {
    dataSource = "cached";
  } else if (cached.computedTurns > 0 && cached.pendingTurns > 0) {
    dataSource = "partial";
    projectedPromptTokens = estimatePartialProjection(cached);
  } else {
    dataSource = "live";
    const cumulative = computeCumulativeContextProjection(db);
    projectedPromptTokens = cumulative.projectedPromptTokens;
    chatsAnalyzed = cumulative.chatsAnalyzed;
    analyzedAssistantTurns = cumulative.analyzedAssistantTurns;

    const uncoveredPromptTokens = Math.max(
      0,
      measuredPromptTokens - cumulative.measuredPromptTokens,
    );
    const contextInflationRatioForUncovered =
      cumulative.measuredPromptTokens > 0
        ? Math.max(
            1,
            cumulative.projectedPromptTokens /
              cumulative.measuredPromptTokens,
          )
        : 1;
    projectedPromptTokens +=
      Math.round(uncoveredPromptTokens * contextInflationRatioForUncovered);
  }

  const contextInflationRatio =
    measuredPromptTokens > 0
      ? Math.max(1, projectedPromptTokens / measuredPromptTokens)
      : 1;

  const hypotheticalTokensWithoutOptimizations =
    projectedPromptTokens + completionTokens + memory.tokensSaved;

  const lifetimeTokensSaved = Math.max(
    0,
    hypotheticalTokensWithoutOptimizations - totalTokensConsumed,
  );

  const contextTokensSaved =
    turnFootprint.truncationTokensSaved + turnFootprint.summaryTokensSaved;
  const totalTokensSaved = contextTokensSaved + memory.tokensSaved;

  const efficiencyScore = efficiencyScoreFrom(
    lifetimeTokensSaved,
    hypotheticalTokensWithoutOptimizations,
  );

  const costSavings = computeModelAwareCostSavings(db, contextInflationRatio);
  const costEfficiencyScore =
    costSavings.hypotheticalCostWithoutOptimizations > 0
      ? Math.min(
          99,
          Math.round(
            (costSavings.lifetimeCostSaved /
              costSavings.hypotheticalCostWithoutOptimizations) *
              100,
          ),
        )
      : 0;

  const now = new Date();

  return {
    fullChatTokensPerTurn: turnFootprint.fullChatTokensPerTurn,
    agentContextTokensPerTurn: turnFootprint.agentContextTokensPerTurn,
    truncationTokensSaved: turnFootprint.truncationTokensSaved,
    summaryTokensSaved: turnFootprint.summaryTokensSaved,
    memorySearchTokensSaved: memory.tokensSaved,
    totalTokensSaved,
    totalTokensConsumed,
    hypotheticalTokensWithoutOptimizations,
    lifetimeTokensSaved,
    contextInflationRatio,
    efficiencyScore,
    actualCost: costSavings.actualCost,
    hypotheticalCostWithoutOptimizations:
      costSavings.hypotheticalCostWithoutOptimizations,
    lifetimeCostSaved: costSavings.lifetimeCostSaved,
    costEfficiencyScore,
    dataSource,
    pendingFootprintTurns: cached.pendingTurns,
    periods: {
      today: computePeriodStats(
        db,
        periodStartIso("today", now),
        contextInflationRatio,
      ),
      thisWeek: computePeriodStats(
        db,
        periodStartIso("week", now),
        contextInflationRatio,
      ),
      thisMonth: computePeriodStats(
        db,
        periodStartIso("month", now),
        contextInflationRatio,
      ),
    },
    breakdown: {
      chatsAnalyzed,
      chatsWithSummaries: turnFootprint.chatsWithSummaries,
      assistantTurnsAnalyzed: analyzedAssistantTurns,
      memorySearchCount: memory.memorySearchCount,
      hybridBashCount: memory.hybridBashCount,
      memoryHitsAnalyzed: memory.hitsAnalyzed,
      memoryHitsWithSource: memory.hitsWithSource,
      fullReadAvgTokens: memory.fullReadAvgTokens,
      memorySearchAvgTokens: memory.memorySearchAvgTokens,
    },
  };
}
