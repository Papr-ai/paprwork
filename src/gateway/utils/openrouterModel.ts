/**
 * OpenRouter (via Papr proxy) — OpenAI-compatible chat/completions.
 *
 * Models are served only through memory.papr.ai/v1/ai/openrouter (Papr's key,
 * server-side allowlist). Reasoning uses OpenRouter's unified `reasoning`
 * request field and streams back as `delta.reasoning`, the same shape Groq
 * uses, so the Groq stream adapter surfaces it in the UI.
 */

import type { LanguageModel } from "ai";
import type { ModelReasoning } from "../../core/types/agents.js";

/** Picker ids are OpenRouter ids already (vendor/model). */
export function normalizeOpenRouterModelId(modelId: string): string {
  return modelId.trim();
}

export function isOpenRouterModelId(modelId: string | undefined | null): boolean {
  if (!modelId) return false;
  return OPENROUTER_MODEL_IDS.has(modelId.trim().toLowerCase());
}

/** Every OpenRouter model Paprwork offers — must match the memory server allowlist. */
export const OPENROUTER_MODEL_IDS: ReadonlySet<string> = new Set([
  "thinkingmachines/inkling-2-mini",
  "thinkingmachines/inkling-2-small",
  "thinkingmachines/inkling",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4.1-flash-1017",
  "qwen/qwen3.8-flash",
  "qwen/qwen3.7-plus",
  "minimax/minimax-m3",
  "mistralai/mistral-large-4-0",
  "nvidia/nemotron-3.5-lightning",
]);

type OpenRouterEffort = "low" | "medium" | "high";

function mapEffort(effort: ModelReasoning["effort"] | undefined): OpenRouterEffort {
  if (effort === "low") return "low";
  if (effort === "high" || effort === "xhigh" || effort === "max") return "high";
  return "medium";
}

/** Inject OpenRouter's unified reasoning field. */
export function injectOpenRouterRequestBody(
  body: Record<string, unknown>,
  reasoning?: ModelReasoning,
): void {
  // The AI SDK sends providerOptions.openai.reasoningEffort as reasoning_effort;
  // OpenRouter's unified field is `reasoning`, so translate it.
  const sdkEffort = body.reasoning_effort as string | undefined;
  delete body.reasoning_effort;
  if (sdkEffort === "none") {
    body.reasoning = { enabled: false };
    return;
  }
  const effort = reasoning?.effort ?? (sdkEffort as ModelReasoning["effort"] | undefined);
  body.reasoning = { effort: mapEffort(effort) };
}

export interface CreateOpenRouterChatModelOptions {
  apiKey: string;
  baseURL: string;
  headers?: Record<string, string>;
  reasoning?: ModelReasoning;
}

/** AI SDK chat model pointed at the Papr OpenRouter proxy, with reasoning injected. */
export async function createOpenRouterChatModel(
  modelId: string,
  options: CreateOpenRouterChatModelOptions,
): Promise<LanguageModel> {
  const { createOpenAI } = await import("@ai-sdk/openai");
  const baseFetch: typeof fetch = fetch;
  const wrappedFetch: typeof fetch = async (input, init) => {
    if (init?.method === "POST" && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        injectOpenRouterRequestBody(body, options.reasoning);
        return baseFetch(input, { ...init, body: JSON.stringify(body) });
      } catch {
        // not JSON — send as is
      }
    }
    return baseFetch(input, init);
  };
  const provider = createOpenAI({
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    headers: options.headers,
    fetch: wrappedFetch,
  });
  return provider.chat(normalizeOpenRouterModelId(modelId)) as LanguageModel;
}
