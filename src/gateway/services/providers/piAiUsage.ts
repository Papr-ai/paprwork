import type { AssistantMessageEvent } from "@mariozechner/pi-ai";

/** Token usage normalized for Paprwork billing (matches StoredTokenUsage shape). */
export interface PiAiBillingUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const EMPTY_PI_AI_BILLING_USAGE: PiAiBillingUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** Extract usage from pi-ai done event (usage lives on event.message, not event.usage). */
export function extractPiAiUsageFromDoneEvent(
  event: AssistantMessageEvent,
): PiAiBillingUsage | null {
  if (event.type !== "done") {
    return null;
  }

  const usage = event.message?.usage;
  if (!usage) {
    return null;
  }

  const promptTokens = usage.input ?? 0;
  const completionTokens = usage.output ?? 0;
  const cacheReadTokens = usage.cacheRead ?? 0;
  const cacheWriteTokens = usage.cacheWrite ?? 0;
  const totalTokens =
    usage.totalTokens ??
    promptTokens + completionTokens + cacheReadTokens + cacheWriteTokens;

  if (
    totalTokens === 0 &&
    promptTokens === 0 &&
    completionTokens === 0 &&
    cacheReadTokens === 0 &&
    cacheWriteTokens === 0
  ) {
    return null;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

/** Sum per-step usage across a multi-step tool loop (one assistant message). */
export function accumulatePiAiBillingUsage(
  accumulated: PiAiBillingUsage,
  step: PiAiBillingUsage,
): PiAiBillingUsage {
  return {
    promptTokens: accumulated.promptTokens + step.promptTokens,
    completionTokens: accumulated.completionTokens + step.completionTokens,
    cacheReadTokens: accumulated.cacheReadTokens + step.cacheReadTokens,
    cacheWriteTokens: accumulated.cacheWriteTokens + step.cacheWriteTokens,
    totalTokens: accumulated.totalTokens + step.totalTokens,
  };
}

/** Current prompt context size for pressure checks (last step's full input). */
export function getPiAiContextTokensFromStep(step: PiAiBillingUsage): number {
  return step.promptTokens + step.cacheReadTokens + step.cacheWriteTokens;
}
