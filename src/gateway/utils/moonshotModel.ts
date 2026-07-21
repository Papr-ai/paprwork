/**
 * Moonshot Kimi model helpers (OpenAI-compatible Chat Completions API)
 */

import type { ModelReasoning } from "../../core/types/agents.js";

/** Map picker IDs to Moonshot API model names */
export function normalizeMoonshotModelId(modelId: string): string {
  if (modelId === "kimi-3" || modelId === "kimi-k3") {
    return "kimi-k3";
  }
  return modelId;
}

/** Kimi K3 only supports reasoning_effort=max (thinking always on). */
export function getMoonshotReasoningEffort(): "max" {
  return "max";
}

/** Provider options for Kimi K3 thinking (top-level reasoning_effort field). */
export function buildMoonshotProviderOptions(
  _modelId: string,
  _reasoning?: ModelReasoning,
): Record<string, Record<string, unknown>> {
  return {
    openai: {
      reasoningEffort: getMoonshotReasoningEffort(),
    },
  };
}
