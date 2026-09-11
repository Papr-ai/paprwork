/**
 * Token accounting across the streams that make up one assistant turn.
 *
 * Providers report usage cumulatively *per stream*: each `step-usage` carries the
 * stream's running total, so "last value wins" is correct while one stream runs.
 *
 * A continuation is a second stream, and its totals start again from zero. Under
 * the same last-value-wins rule the continuation's figures therefore *replace* the
 * first stream's rather than adding to them — so a turn that continued recorded
 * only its tail, and recorded nothing at all when the continuation reported no
 * usage. Those are the long multi-step turns, which is exactly where the money is.
 *
 * The fix is to close off a stream's total before the next one starts, and report
 * the committed total plus whatever the running stream has reached.
 */

export interface TurnUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Absent is not zero here. `cacheReadTokens: undefined` means "this provider did
 * not report it", and downstream billing substitutes a tracked fallback for that
 * case — so coercing it to 0 would erase the other stream's real figure and
 * suppress the fallback.
 */
function addOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) {
    return undefined;
  }
  return (a ?? 0) + (b ?? 0);
}

/** Sum two usage totals. The result is defined whenever either side is. */
export function addTurnUsage<T extends TurnUsage>(
  committed: T | undefined,
  current: T,
): T;
export function addTurnUsage<T extends TurnUsage>(
  committed: T,
  current: T | undefined,
): T;
export function addTurnUsage<T extends TurnUsage>(
  committed: T | undefined,
  current: T | undefined,
): T | undefined;
export function addTurnUsage<T extends TurnUsage>(
  committed: T | undefined,
  current: T | undefined,
): T | undefined {
  if (!committed) {
    return current;
  }
  if (!current) {
    return committed;
  }

  return {
    // Spread `current` so any provider-specific fields on the live stream survive.
    ...current,
    promptTokens: committed.promptTokens + current.promptTokens,
    completionTokens: committed.completionTokens + current.completionTokens,
    totalTokens: committed.totalTokens + current.totalTokens,
    cacheReadTokens: addOptional(committed.cacheReadTokens, current.cacheReadTokens),
    cacheWriteTokens: addOptional(committed.cacheWriteTokens, current.cacheWriteTokens),
  };
}
