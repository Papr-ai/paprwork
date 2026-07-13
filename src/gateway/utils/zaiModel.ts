/**
 * Z.ai GLM model helpers (OpenAI-compatible API)
 */

import type { ModelReasoning, ReasoningEffort } from "../../core/types/agents.js";

/** Map picker IDs to Z.ai API model names */
export function normalizeZaiModelId(modelId: string): string {
  if (modelId === "glm-5.2-max") {
    return "glm-5.2";
  }
  return modelId;
}

/** Z.ai reasoning_effort from picker config */
export function getZaiReasoningEffort(
  modelId: string,
  effort?: ReasoningEffort,
): "high" | "max" {
  if (modelId === "glm-5.2-max" || effort === "max" || effort === "xhigh") {
    return "max";
  }
  return "high";
}

/** Provider options for Z.ai thinking + reasoning (OpenAI-compatible body fields) */
export function buildZaiProviderOptions(
  modelId: string,
  reasoning?: ModelReasoning,
): Record<string, Record<string, unknown>> {
  return {
    openai: {
      thinking: { type: "enabled" },
      reasoning_effort: getZaiReasoningEffort(modelId, reasoning?.effort),
    },
  };
}
