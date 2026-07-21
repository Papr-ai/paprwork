/**
 * Model-aware context budgeting for AI SDK streaming.
 * Keeps in-flight prompts under each model's real context window (tools + output reserved).
 */

import { ModelFallback } from "../../../core/agents/ModelFallback.js";
import type { Provider } from "../../../core/types/agents.js";

const fallback = new ModelFallback();

const PROVIDER_DEFAULT_CONTEXT: Partial<Record<Provider, number>> = {
  groq: 131_072,
  moonshot: 1_048_576,
  ollama: 32_768,
  openai: 128_000,
  anthropic: 200_000,
  google: 1_048_576,
  zai: 128_000,
};

/** Resolve context window for a provider/model pair. */
export function resolveModelContextWindow(
  provider: Provider,
  modelId: string,
): number {
  const info = fallback.getModelInfo(modelId);
  if (info?.contextWindow) {
    return info.contextWindow;
  }
  return PROVIDER_DEFAULT_CONTEXT[provider] ?? 128_000;
}

/** Fraction of context window available for message history (rest: tools + output). */
const HISTORY_BUDGET_RATIO = 0.85;

/** Output reserve when maxTokens is not set on the request. */
const DEFAULT_OUTPUT_RESERVE = 16_000;

/**
 * Gemini models advertise a 1M window, but long tool-heavy history degrades quality.
 * Cap message-history budget and trigger summarize/trim above this.
 */
export const GEMINI_HISTORY_TOKEN_CAP = 150_000;

/** Default history-token threshold before proactive summarization (non-Gemini). */
export const DEFAULT_SUMMARIZE_HISTORY_TOKEN_THRESHOLD = 40_000;

export function isGoogleGeminiProvider(provider: Provider): boolean {
  return provider === "google";
}

/** History-token threshold for proactive summarization (provider-aware). */
export function resolveSummarizeHistoryTokenThreshold(
  provider: Provider,
): number {
  if (isGoogleGeminiProvider(provider)) {
    return GEMINI_HISTORY_TOKEN_CAP;
  }
  return DEFAULT_SUMMARIZE_HISTORY_TOKEN_THRESHOLD;
}

/** Re-summarize when Gemini history still exceeds the cap despite an existing summary. */
export function shouldForceGeminiResummarize(
  provider: Provider,
  estimatedHistoryTokens: number,
): boolean {
  return (
    isGoogleGeminiProvider(provider) &&
    estimatedHistoryTokens >= GEMINI_HISTORY_TOKEN_CAP
  );
}

/**
 * Token budget for message history mid-turn (excludes tool schemas and output).
 * Returns at least 8K so trimming still runs on small windows.
 * Google/Gemini: capped at {@link GEMINI_HISTORY_TOKEN_CAP} for quality.
 */
export function computeHistoryTokenBudget(params: {
  provider: Provider;
  modelId: string;
  toolTokenEstimate: number;
  maxOutputTokens?: number;
}): number {
  const contextWindow = resolveModelContextWindow(
    params.provider,
    params.modelId,
  );
  const outputReserve = params.maxOutputTokens ?? DEFAULT_OUTPUT_RESERVE;
  const budget = Math.floor(
    contextWindow * HISTORY_BUDGET_RATIO -
      params.toolTokenEstimate -
      outputReserve,
  );
  let capped = Math.max(budget, 8_000);
  if (isGoogleGeminiProvider(params.provider)) {
    capped = Math.min(capped, GEMINI_HISTORY_TOKEN_CAP);
  }
  return capped;
}

/** Whether an API/stream error indicates the prompt exceeded the model context window. */
export function isContextLengthError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("context_length_exceeded") ||
    lower.includes("context length exceeded") ||
    lower.includes("reduce the length of the messages") ||
    lower.includes("maximum context length") ||
    lower.includes("context limit")
  );
}
