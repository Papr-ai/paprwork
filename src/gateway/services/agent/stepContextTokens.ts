/**
 * Context size for a single model step, derived from the usage a provider reports.
 *
 * Providers disagree on whether `inputTokens` already contains the cached
 * portion of the prompt. `@ai-sdk/anthropic` 3.x reports the sum — its own
 * mapping is `total: inputTokens + cacheCreationTokens + cacheReadTokens` — so
 * adding the cache figures on top doubles the number. Other providers, and
 * earlier versions, report only the uncached remainder, where adding them is
 * required to get the real context size.
 *
 * Encoding one convention is what produced the doubling: a comment asserted
 * "inputTokens is the uncached portion only", the SDK had since changed, and a
 * 384K context was reported as 769K on every step. Detect it instead — the
 * cached portion is part of the prompt, so it cannot exceed the total input.
 * An `inputTokens` at least as large as the cache figures must already contain
 * them.
 *
 * Known limit: under the exclusive convention with more fresh tokens than
 * cached ones, this reads as inclusive and under-reports. That requires the
 * cacheable prefix to be smaller than one turn's new content, i.e. caching
 * barely helping — and it is the same direction the old code was wrong in for
 * non-cached providers, rather than a new failure.
 */
export function resolveStepContextTokens(usage: {
  inputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): number {
  const cached = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  if (cached === 0) {
    return usage.inputTokens;
  }
  return usage.inputTokens >= cached
    ? usage.inputTokens
    : usage.inputTokens + cached;
}
