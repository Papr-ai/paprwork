/**
 * Per-turn efficiency and quality measurements.
 *
 * The cost of a turn is dominated by how many *steps* it takes, not by how
 * large any single payload is: every step re-sends the whole context. Yet step
 * count was persisted nowhere, so the one number that explains spend could only
 * be guessed at.
 *
 * The other blind spot this closes is the redundant recovery — the agent
 * fetching back a tool result that compaction had cut, when the result was
 * small enough that it would have arrived whole had it still been fresh. That
 * loop costs a full extra step to recover a few hundred characters, and it took
 * a retrospective join across sibling tool calls to see at all. Counting it as
 * it happens makes any change to the truncation policy measurable.
 *
 * Everything here is a count, a ratio, or a token total. No message content, no
 * tool arguments, no file paths — so the same record is safe to keep locally and
 * to report in aggregate.
 */

import { ABSOLUTE_TOOL_RESULT_MAX_CHARS } from "./toolResultTruncation.js";

export interface TurnMetrics {
  /** Model round-trips in this turn, including continuations. */
  steps: number;
  toolCalls: number;
  /** Times compaction ran, whether or not it cut anything. */
  compactionRuns: number;
  /** Times the pressure gate declined to run compaction. */
  compactionSkips: number;
  staleResultsTruncated: number;
  staleResultsLeftInline: number;
  recoveryFetches: number;
  /** Fetches recovering a result that would have fit the fresh ceiling. */
  redundantRecoveries: number;
  recoveredChars: number;
  /** Largest context observed at a step boundary. */
  peakContextTokens: number;
  historyTokenBudget: number;
}

export function createTurnMetrics(): TurnMetrics {
  return {
    steps: 0,
    toolCalls: 0,
    compactionRuns: 0,
    compactionSkips: 0,
    staleResultsTruncated: 0,
    staleResultsLeftInline: 0,
    recoveryFetches: 0,
    redundantRecoveries: 0,
    recoveredChars: 0,
    peakContextTokens: 0,
    historyTokenBudget: 0,
  };
}

export function recordStep(
  metrics: TurnMetrics | null | undefined,
  info: { estimatedTokens?: number; historyTokenBudget?: number },
): void {
  if (!metrics) return;
  metrics.steps += 1;
  if (info.estimatedTokens !== undefined && Number.isFinite(info.estimatedTokens)) {
    metrics.peakContextTokens = Math.max(
      metrics.peakContextTokens,
      Math.round(info.estimatedTokens),
    );
  }
  if (
    info.historyTokenBudget !== undefined &&
    Number.isFinite(info.historyTokenBudget) &&
    info.historyTokenBudget > 0
  ) {
    metrics.historyTokenBudget = info.historyTokenBudget;
  }
}

/**
 * Tool calls are set from the turn's finished tool-call list rather than
 * counted as they happen, because both routes produce that list and counting
 * per route would double it on whichever route also reports its own total.
 */
export function setToolCallCount(
  metrics: TurnMetrics | null | undefined,
  count: number,
): void {
  if (!metrics) return;
  metrics.toolCalls = Math.max(0, count);
}

/**
 * For loops that keep their own step counter, reported once at the end rather
 * than incremented per iteration — the OAuth route advances its step counter
 * from several branches, and hooking each one invites drift.
 */
export function recordLoopSteps(
  metrics: TurnMetrics | null | undefined,
  totals: {
    steps: number;
    estimatedTokens?: number;
    historyTokenBudget?: number;
  },
): void {
  if (!metrics) return;
  metrics.steps += Math.max(0, totals.steps);
  if (
    totals.estimatedTokens !== undefined &&
    Number.isFinite(totals.estimatedTokens)
  ) {
    metrics.peakContextTokens = Math.max(
      metrics.peakContextTokens,
      Math.round(totals.estimatedTokens),
    );
  }
  if (
    totals.historyTokenBudget !== undefined &&
    Number.isFinite(totals.historyTokenBudget) &&
    totals.historyTokenBudget > 0
  ) {
    metrics.historyTokenBudget = totals.historyTokenBudget;
  }
}

export interface CompactionOutcome {
  staleResultsTruncated?: number;
  staleResultsLeftInline?: number;
}

export function recordCompactionRun(
  metrics: TurnMetrics | null | undefined,
  outcome: CompactionOutcome,
): void {
  if (!metrics) return;
  metrics.compactionRuns += 1;
  metrics.staleResultsTruncated += outcome.staleResultsTruncated ?? 0;
  metrics.staleResultsLeftInline += outcome.staleResultsLeftInline ?? 0;
}

export function recordCompactionSkipped(
  metrics: TurnMetrics | null | undefined,
): void {
  if (!metrics) return;
  metrics.compactionSkips += 1;
}

/**
 * A recovery is redundant when the recovered result would have been delivered
 * whole had it still been fresh — the fetch bought back something the turn was
 * never going to lose. That is the signal a truncation policy is cutting below
 * the point where cutting pays.
 */
export function isRedundantRecovery(
  recoveredChars: number,
  freshCeiling: number = ABSOLUTE_TOOL_RESULT_MAX_CHARS,
): boolean {
  return recoveredChars > 0 && recoveredChars <= freshCeiling;
}

export function recordRecoveryFetch(
  metrics: TurnMetrics | null | undefined,
  recoveredChars: number,
): void {
  if (!metrics) return;
  metrics.recoveryFetches += 1;
  metrics.recoveredChars += Math.max(0, recoveredChars);
  if (isRedundantRecovery(recoveredChars)) {
    metrics.redundantRecoveries += 1;
  }
}

/** Plan progress at turn end — the cheapest quality signal we already collect. */
export interface TurnPlanProgress {
  planCount: number;
  totalSteps: number;
  completedSteps: number;
  pendingSteps: number;
}

/**
 * The flat, numeric shape written to storage and reported in aggregate.
 * Ratios are derived here so every consumer reads the same arithmetic.
 */
export interface TurnMetricsSummary {
  steps: number;
  toolCalls: number;
  compactionRuns: number;
  compactionSkips: number;
  staleResultsTruncated: number;
  staleResultsLeftInline: number;
  recoveryFetches: number;
  redundantRecoveries: number;
  recoveredChars: number;
  peakContextTokens: number;
  historyTokenBudget: number;
  /** Peak context as a fraction of the budget, or null when no budget applied. */
  contextFillRatio: number | null;
  /** Redundant recoveries per tool call — the loop's rate, directly. */
  redundantRecoveryRate: number | null;
  planCount: number;
  planTotalSteps: number;
  planCompletedSteps: number;
  /** True only when a plan existed and finished. Null when no plan ran. */
  planCompleted: boolean | null;
}

export function summarizeTurnMetrics(
  metrics: TurnMetrics,
  plan?: TurnPlanProgress,
): TurnMetricsSummary {
  const contextFillRatio =
    metrics.historyTokenBudget > 0
      ? round3(metrics.peakContextTokens / metrics.historyTokenBudget)
      : null;

  const redundantRecoveryRate =
    metrics.toolCalls > 0
      ? round3(metrics.redundantRecoveries / metrics.toolCalls)
      : null;

  const planCount = plan?.planCount ?? 0;

  return {
    steps: metrics.steps,
    toolCalls: metrics.toolCalls,
    compactionRuns: metrics.compactionRuns,
    compactionSkips: metrics.compactionSkips,
    staleResultsTruncated: metrics.staleResultsTruncated,
    staleResultsLeftInline: metrics.staleResultsLeftInline,
    recoveryFetches: metrics.recoveryFetches,
    redundantRecoveries: metrics.redundantRecoveries,
    recoveredChars: metrics.recoveredChars,
    peakContextTokens: metrics.peakContextTokens,
    historyTokenBudget: metrics.historyTokenBudget,
    contextFillRatio,
    redundantRecoveryRate,
    planCount,
    planTotalSteps: plan?.totalSteps ?? 0,
    planCompletedSteps: plan?.completedSteps ?? 0,
    planCompleted: planCount > 0 ? (plan?.pendingSteps ?? 0) === 0 : null,
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
