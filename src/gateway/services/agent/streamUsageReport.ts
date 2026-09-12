/**
 * One usage contract for two routes that report differently.
 *
 * The consumer in `AgentService` treats each usage report as the running total
 * for its stream — correct for pi-ai, which accumulates its own tool loop and
 * emits a single `finish` at the end. The AI SDK reports per *step*, so under
 * the same rule every step but the last was discarded and a 39-step turn was
 * billed as one request.
 *
 * These helpers let the orchestrator translate both into that one contract, so
 * the consumer does not have to know which provider it is reading.
 */

export interface StreamUsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const EMPTY_STREAM_USAGE: StreamUsageTotals = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** AI SDK v6 usage shape (`inputTokens` already contains the cached portion). */
interface AiSdkUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  cachedInputTokens?: number;
}

/** pi-ai's normalized shape, already summed across its tool loop. */
interface PiAiUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

function hasAnyTokens(usage: StreamUsageTotals): boolean {
  return (
    usage.promptTokens > 0 ||
    usage.completionTokens > 0 ||
    usage.totalTokens > 0 ||
    usage.cacheReadTokens > 0 ||
    usage.cacheWriteTokens > 0
  );
}

/**
 * Read one AI SDK step's usage.
 *
 * `providerMetadata` is a legitimate source here because it describes this step,
 * and Anthropic populates `inputTokenDetails` while some providers only surface
 * `cachedInputTokens`.
 */
export function readAiSdkStepUsage(chunk: {
  usage?: AiSdkUsage;
  providerMetadata?: {
    anthropic?: {
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
    };
  };
}): StreamUsageTotals | null {
  const usage = chunk.usage;
  if (!usage) return null;

  const details = usage.inputTokenDetails;
  const anthropic = chunk.providerMetadata?.anthropic;

  const totals: StreamUsageTotals = {
    promptTokens: usage.inputTokens ?? 0,
    completionTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    cacheReadTokens:
      details?.cacheReadTokens ??
      anthropic?.cacheReadInputTokens ??
      usage.cachedInputTokens ??
      0,
    cacheWriteTokens:
      details?.cacheWriteTokens ?? anthropic?.cacheCreationInputTokens ?? 0,
  };

  return hasAnyTokens(totals) ? totals : null;
}

/**
 * Read the AI SDK's own cross-step total from a `finish` chunk.
 *
 * Deliberately does **not** consult `providerMetadata`: the SDK sums `usage`
 * across steps but carries only the *last* step's provider metadata, so falling
 * back to it would report one step's cache figures as the whole stream's — the
 * exact defect this module exists to close.
 */
export function readAiSdkTotalUsage(chunk: {
  totalUsage?: AiSdkUsage;
}): StreamUsageTotals | null {
  const usage = chunk.totalUsage;
  if (!usage) return null;

  const details = usage.inputTokenDetails;

  const totals: StreamUsageTotals = {
    promptTokens: usage.inputTokens ?? 0,
    completionTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    cacheReadTokens: details?.cacheReadTokens ?? usage.cachedInputTokens ?? 0,
    cacheWriteTokens: details?.cacheWriteTokens ?? 0,
  };

  return hasAnyTokens(totals) ? totals : null;
}

/** Read pi-ai's accumulated total, which arrives once per stream. */
export function readPiAiStreamUsage(chunk: {
  usage?: PiAiUsage;
}): StreamUsageTotals | null {
  const usage = chunk.usage;
  if (!usage) return null;

  const totals: StreamUsageTotals = {
    promptTokens: usage.promptTokens ?? 0,
    completionTokens: usage.completionTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  };

  return hasAnyTokens(totals) ? totals : null;
}

/** Fold one step into the stream's running total. */
export function addStreamUsage(
  running: StreamUsageTotals,
  step: StreamUsageTotals,
): StreamUsageTotals {
  return {
    promptTokens: running.promptTokens + step.promptTokens,
    completionTokens: running.completionTokens + step.completionTokens,
    totalTokens: running.totalTokens + step.totalTokens,
    cacheReadTokens: running.cacheReadTokens + step.cacheReadTokens,
    cacheWriteTokens: running.cacheWriteTokens + step.cacheWriteTokens,
  };
}
