import type Database from "better-sqlite3";
import {
  computeCumulativeContextProjection,
  computeTurnFootprintsFast,
} from "./contextFootprintSql.js";
import {
  estimatePartialProjection,
  readCachedLifetimeProjection,
} from "./contextFootprintStore.js";
import { computeModelAwareCostSavings } from "./contextCostSavings.js";
import { computeMemorySearchSavings } from "./memorySearchSavings.js";

export type ContextEfficiencyDataSource = "cached" | "partial" | "live";

export interface ContextEfficiencyStats {
  /** Sum across chats: full stored history if sent every turn (naive) */
  fullChatTokensPerTurn: number;
  /** Sum across chats: what loadMessagesForLLM + historyFormatter sends each turn */
  agentContextTokensPerTurn: number;
  truncationTokensSaved: number;
  summaryTokensSaved: number;
  memorySearchTokensSaved: number;
  totalTokensSaved: number;
  totalTokensConsumed: number;
  /** Estimated total API tokens if same work ran without Paprwork optimizations */
  hypotheticalTokensWithoutOptimizations: number;
  /** Tokens avoided vs hypothetical (matches totalTokensConsumed savings story) */
  lifetimeTokensSaved: number;
  /** How much larger cumulative context would have been (naive ÷ optimized) */
  contextInflationRatio: number;
  /** % of hypothetical spend avoided */
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

export function computeContextEfficiencyStats(
  db: Database.Database,
): ContextEfficiencyStats {
  const turnFootprint = computeTurnFootprintsFast(db);
  const memory = computeMemorySearchSavings(db);
  const cached = readCachedLifetimeProjection(db);

  const promptTokens = cached.measuredPromptTokens;
  const completionTokens = cached.completionTokens;
  const totalTokensConsumed = cached.totalTokensConsumed;

  let dataSource: ContextEfficiencyDataSource;
  let measuredPromptTokens = promptTokens;
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
    projectedPromptTokens = estimatePartialProjection(db, cached);
  } else {
    dataSource = "live";
    const cumulative = computeCumulativeContextProjection(db);
    measuredPromptTokens = cumulative.measuredPromptTokens;
    projectedPromptTokens = cumulative.projectedPromptTokens;
    chatsAnalyzed = cumulative.chatsAnalyzed;
    analyzedAssistantTurns = cumulative.analyzedAssistantTurns;

    const uncoveredPromptTokens = Math.max(
      0,
      promptTokens - cumulative.measuredPromptTokens,
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

  const hypotheticalPromptTokens = projectedPromptTokens;
  const hypotheticalTokensWithoutOptimizations =
    hypotheticalPromptTokens + completionTokens + memory.tokensSaved;

  const lifetimeTokensSaved = Math.max(
    0,
    hypotheticalTokensWithoutOptimizations - totalTokensConsumed,
  );

  const contextTokensSaved =
    turnFootprint.truncationTokensSaved + turnFootprint.summaryTokensSaved;
  const totalTokensSaved = contextTokensSaved + memory.tokensSaved;

  const efficiencyScore =
    hypotheticalTokensWithoutOptimizations > 0
      ? Math.min(
          99,
          Math.round(
            (lifetimeTokensSaved / hypotheticalTokensWithoutOptimizations) *
              100,
          ),
        )
      : 0;

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
