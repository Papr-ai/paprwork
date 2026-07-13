/**
 * Groq model helpers (OpenAI-compatible Chat Completions API)
 * Prompt caching is automatic on GPT-OSS — no client-side cache_control needed.
 */

import type { ModelReasoning } from "../../core/types/agents.js";

/** Map picker IDs to Groq API model names */
export function normalizeGroqModelId(modelId: string): string {
  return modelId;
}

/** Map picker reasoning effort to AI SDK openai.reasoningEffort (camelCase). */
function mapGroqReasoningEffort(
  effort: ModelReasoning["effort"] | undefined,
): "low" | "medium" | "high" {
  if (effort === "low") return "low";
  if (effort === "high" || effort === "xhigh" || effort === "max") {
    return "high";
  }
  return "medium";
}

/** Provider options passed through AI SDK (reasoning_format is injected via fetch). */
export function buildGroqProviderOptions(
  modelId: string,
  reasoning?: ModelReasoning,
): Record<string, Record<string, unknown>> {
  const normalized = normalizeGroqModelId(modelId);

  if (normalized.startsWith("openai/gpt-oss")) {
    return {
      openai: {
        reasoningEffort: mapGroqReasoningEffort(reasoning?.effort),
      },
    };
  }

  return {};
}
