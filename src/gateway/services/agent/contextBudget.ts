/**
 * Model-aware context budgeting for AI SDK streaming.
 * Keeps in-flight prompts under each model's real context window (tools + output reserved).
 */

import { ModelFallback } from "../../../core/agents/ModelFallback.js";
import type { Provider } from "../../../core/types/agents.js";

const fallback = new ModelFallback();

const PROVIDER_DEFAULT_CONTEXT: Partial<Record<Provider, number>> = {
  groq: 131_072,
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
 * Token budget for message history mid-turn (excludes tool schemas and output).
 * Returns at least 8K so trimming still runs on small windows.
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
  return Math.max(budget, 8_000);
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
