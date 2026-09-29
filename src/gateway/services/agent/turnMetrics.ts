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
  /**
   * Largest whole-prompt context the *provider* reported for a step.
   *
   * Kept apart from the estimate below because the two answer different
   * questions and disagree by roughly 1.9× on real turns: this is what was
   * billed, that is what the truncation ladder believed. Conflating them meant
   * every recorded peak was the belief, while the provider's own figure was
   * computed a few lines away for the summarization decision and discarded.
   */
  observedPeakContextTokens: number;
  /** Largest `chars/4` estimate seen at a step boundary — the ladder's own view. */
  estimatedPeakContextTokens: number;
  historyTokenBudget: number;
  /**
   * Batching nudges appended this turn, and the tool schemas withheld from it.
   *
   * Both are the intervention side of `toolCallsPerStep` and the tool-block
   * size: without them a change in either ratio cannot be attributed, since a
   * turn whose width rose on its own and one that was nudged four times read
   * identically. Recorded rather than inferred from the prompt, which is not
   * kept.
   */
  widthNudgesIssued: number;
  deferredToolCount: number;
  deferredToolTokens: number;
  /**
   * Memory-catalog experiment (Jev gate). Arm is null when the turn was not
   * assigned; token fields are what the positional block would have cost vs
   * what was injected. Set once, on the turn that injects the deferred block.
   */
  catalogExperimentArm: "treatment" | "control" | null;
  catalogPositionalTokens: number | null;
  catalogInjectedTokens: number | null;
  catalogJevMs: number | null;
  /** Tool-result trim experiment (Jev). See jevToolResultTrim.ts. */
  toolTrimArm: "treatment" | "control" | null;
  /**
   * Auto model routing (Jev). Recorded every turn in shadow mode; `applied`
   * is 1 only when the picker model was `auto` and the pick replaced config.
   */
  autoTier: string | null;
  autoRawTier: string | null;
  autoConfidence: number | null;
  autoNeedsTools: boolean | null;
  autoModel: string | null;
  autoEffort: string | null;
  autoApplied: boolean;
  autoJevMs: number | null;
  toolTrimApplied: number;
  toolTrimFallbacks: number;
  toolTrimLookbackYes: number;
  toolTrimCharsBefore: number;
  toolTrimCharsAfter: number;
  toolTrimJevMs: number;
}

export function recordAutoRoute(
  metrics: TurnMetrics | null | undefined,
  rec: {
    tier: string;
    rawTier: string;
    confidence: number;
    needsTools: boolean;
    model: string | null;
    effort: string | null;
    applied: boolean;
    jevMs: number;
  },
): void {
  if (!metrics) return;
  metrics.autoTier = rec.tier;
  metrics.autoRawTier = rec.rawTier;
  metrics.autoConfidence = rec.confidence;
  metrics.autoNeedsTools = rec.needsTools;
  metrics.autoModel = rec.model;
  metrics.autoEffort = rec.effort;
  metrics.autoApplied = rec.applied;
  metrics.autoJevMs = rec.jevMs;
}

export function recordToolTrimArm(
  metrics: TurnMetrics | null | undefined,
  arm: "treatment" | "control" | null,
): void {
  if (metrics) metrics.toolTrimArm = arm;
}

export function recordToolTrimApplied(
  metrics: TurnMetrics | null | undefined,
  rec: { charsBefore: number; charsAfter: number; jevMs: number; lookback: boolean },
): void {
  if (!metrics) return;
  metrics.toolTrimApplied += 1;
  metrics.toolTrimCharsBefore += rec.charsBefore;
  metrics.toolTrimCharsAfter += rec.charsAfter;
  metrics.toolTrimJevMs += rec.jevMs;
  if (rec.lookback) metrics.toolTrimLookbackYes += 1;
}

export function recordToolTrimFallback(metrics: TurnMetrics | null | undefined): void {
  if (metrics) metrics.toolTrimFallbacks += 1;
}

export function recordCatalogExperiment(
  metrics: TurnMetrics | null | undefined,
  rec: {
    arm: "treatment" | "control" | null;
    positionalTokens: number;
    gatedTokens: number | null;
    jevMs: number | null;
  } | null,
): void {
  if (!metrics || !rec) return;
  metrics.catalogExperimentArm = rec.arm;
  metrics.catalogPositionalTokens = rec.positionalTokens;
  metrics.catalogInjectedTokens =
    rec.arm === "treatment" && rec.gatedTokens !== null
      ? rec.gatedTokens
      : rec.positionalTokens;
  metrics.catalogJevMs = rec.jevMs;
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
    observedPeakContextTokens: 0,
    estimatedPeakContextTokens: 0,
    historyTokenBudget: 0,
    widthNudgesIssued: 0,
    deferredToolCount: 0,
    deferredToolTokens: 0,
    catalogExperimentArm: null,
    catalogPositionalTokens: null,
    catalogInjectedTokens: null,
    catalogJevMs: null,
    toolTrimArm: null,
    autoTier: null,
    autoRawTier: null,
    autoConfidence: null,
    autoNeedsTools: null,
    autoModel: null,
    autoEffort: null,
    autoApplied: false,
    autoJevMs: null,
    toolTrimApplied: 0,
    toolTrimFallbacks: 0,
    toolTrimLookbackYes: 0,
    toolTrimCharsBefore: 0,
    toolTrimCharsAfter: 0,
    toolTrimJevMs: 0,
  };
}

/**
 * Set once per turn, from the selection made before the first step.
 *
 * Set rather than accumulated because the selection is fixed for the whole turn
 * by design — see `toolDeferral.ts`. If this ever starts accumulating, the tool
 * block is changing mid-turn and the cache write is costing more than the
 * deferral saves.
 */
export function recordToolDeferral(
  metrics: TurnMetrics | null | undefined,
  selection: { deferredCount: number; savedTokens: number },
): void {
  if (!metrics) return;
  metrics.deferredToolCount = Math.max(0, selection.deferredCount);
  metrics.deferredToolTokens = Math.max(0, selection.savedTokens);
}

export function recordWidthNudge(
  metrics: TurnMetrics | null | undefined,
): void {
  if (!metrics) return;
  metrics.widthNudgesIssued += 1;
}

export function recordStep(
  metrics: TurnMetrics | null | undefined,
  info: { estimatedTokens?: number; historyTokenBudget?: number },
): void {
  if (!metrics) return;
  metrics.steps += 1;
  if (info.estimatedTokens !== undefined && Number.isFinite(info.estimatedTokens)) {
    metrics.estimatedPeakContextTokens = Math.max(
      metrics.estimatedPeakContextTokens,
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
    metrics.estimatedPeakContextTokens = Math.max(
      metrics.estimatedPeakContextTokens,
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

/**
 * Raise the peak from a figure the provider reported, rather than one we
 * estimated.
 *
 * Both routes already compute this — the AI SDK route in `onStepFinish` and the
 * OAuth loop when a step's usage arrives — and both then used it only for
 * in-flight decisions. A turn that reports no usage at all leaves this at zero,
 * which is the signal the summary uses to fall back to the estimate.
 */
export function recordObservedContext(
  metrics: TurnMetrics | null | undefined,
  contextTokens: number,
): void {
  if (!metrics) return;
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) return;
  metrics.observedPeakContextTokens = Math.max(
    metrics.observedPeakContextTokens,
    Math.round(contextTokens),
  );
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
  /** The provider's figure when a step reported one, else the estimate. */
  peakContextTokens: number;
  /** The `chars/4` estimate on its own, kept so estimator drift stays visible. */
  estimatedContextTokens: number;
  historyTokenBudget: number;
  /**
   * The *estimated* peak as a fraction of the budget — deliberately not the
   * observed one. This measures how full the truncation ladder believed it was,
   * which is the quantity its 70% gate actually compares, so substituting the
   * provider's figure would break the one thing this ratio reports faithfully.
   */
  contextFillRatio: number | null;
  /**
   * How many times larger the billed prompt was than the estimate, or null when
   * one of the two is missing. This is the calibration signal: sustained values
   * above 1 mean the ladder's gate fires later than its ratio implies.
   */
  estimatorErrorRatio: number | null;
  /** Redundant recoveries per tool call — the loop's rate, directly. */
  redundantRecoveryRate: number | null;
  /**
   * Tool calls per step: how *wide* each round-trip was.
   *
   * Steps are what cost money — every one re-sends the whole context — so the
   * same work batched three-wide costs a third of what it costs one-wide. This
   * is the ratio the batching guidance targets, and the only way to tell a turn
   * that did a lot of work from one that merely took a lot of trips. Null with
   * no steps, so an empty turn does not report a confident 0.
   */
  toolCallsPerStep: number | null;
  /** Batching nudges appended, and schemas withheld — see {@link TurnMetrics}. */
  widthNudgesIssued: number;
  deferredToolCount: number;
  deferredToolTokens: number;
  planCount: number;
  planTotalSteps: number;
  planCompletedSteps: number;
  /** True only when a plan existed and finished. Null when no plan ran. */
  planCompleted: boolean | null;
  /** Memory-catalog experiment — see {@link TurnMetrics}. */
  catalogExperimentArm: "treatment" | "control" | null;
  catalogPositionalTokens: number | null;
  catalogInjectedTokens: number | null;
  catalogJevMs: number | null;
  toolTrimArm: "treatment" | "control" | null;
  autoTier: string | null;
  autoRawTier: string | null;
  autoConfidence: number | null;
  autoNeedsTools: boolean | null;
  autoModel: string | null;
  autoEffort: string | null;
  autoApplied: boolean;
  autoJevMs: number | null;
  toolTrimApplied: number;
  toolTrimFallbacks: number;
  toolTrimLookbackYes: number;
  toolTrimCharsBefore: number;
  toolTrimCharsAfter: number;
  toolTrimJevMs: number;
}

export function summarizeTurnMetrics(
  metrics: TurnMetrics,
  plan?: TurnPlanProgress,
): TurnMetricsSummary {
  const estimated = metrics.estimatedPeakContextTokens;
  const observed = metrics.observedPeakContextTokens;

  const contextFillRatio =
    metrics.historyTokenBudget > 0 && estimated > 0
      ? round3(estimated / metrics.historyTokenBudget)
      : null;

  const estimatorErrorRatio =
    observed > 0 && estimated > 0 ? round3(observed / estimated) : null;

  const redundantRecoveryRate =
    metrics.toolCalls > 0
      ? round3(metrics.redundantRecoveries / metrics.toolCalls)
      : null;

  const toolCallsPerStep =
    metrics.steps > 0 ? round3(metrics.toolCalls / metrics.steps) : null;

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
    peakContextTokens: observed > 0 ? observed : estimated,
    estimatedContextTokens: estimated,
    historyTokenBudget: metrics.historyTokenBudget,
    contextFillRatio,
    estimatorErrorRatio,
    redundantRecoveryRate,
    toolCallsPerStep,
    widthNudgesIssued: metrics.widthNudgesIssued,
    deferredToolCount: metrics.deferredToolCount,
    deferredToolTokens: metrics.deferredToolTokens,
    planCount,
    planTotalSteps: plan?.totalSteps ?? 0,
    planCompletedSteps: plan?.completedSteps ?? 0,
    planCompleted: planCount > 0 ? (plan?.pendingSteps ?? 0) === 0 : null,
    catalogExperimentArm: metrics.catalogExperimentArm,
    catalogPositionalTokens: metrics.catalogPositionalTokens,
    catalogInjectedTokens: metrics.catalogInjectedTokens,
    catalogJevMs: metrics.catalogJevMs,
    toolTrimArm: metrics.toolTrimArm,
    autoTier: metrics.autoTier,
    autoRawTier: metrics.autoRawTier,
    autoConfidence: metrics.autoConfidence,
    autoNeedsTools: metrics.autoNeedsTools,
    autoModel: metrics.autoModel,
    autoEffort: metrics.autoEffort,
    autoApplied: metrics.autoApplied,
    autoJevMs: metrics.autoJevMs,
    toolTrimApplied: metrics.toolTrimApplied,
    toolTrimFallbacks: metrics.toolTrimFallbacks,
    toolTrimLookbackYes: metrics.toolTrimLookbackYes,
    toolTrimCharsBefore: metrics.toolTrimCharsBefore,
    toolTrimCharsAfter: metrics.toolTrimCharsAfter,
    toolTrimJevMs: metrics.toolTrimJevMs,
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
