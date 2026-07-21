/**
 * Groq provider helpers — reasoning_format injection + stream adaptation.
 *
 * The AI SDK OpenAI chat parser only maps delta.content and strips delta.reasoning.
 * Groq Qwen/GPT-OSS reasoning requires:
 * 1. Request body: reasoning_format= parsed (Qwen) or include_reasoning (GPT-OSS)
 * 2. Stream adapter: map raw SSE chunks → reasoning-delta for the UI
 */

import type { LanguageModel } from "ai";
import { normalizeGroqModelId } from "./groqModel.js";

const GROQ_CHAT_COMPLETIONS_PATH = "/chat/completions";

export function isGroqQwenModel(modelId: string): boolean {
  const normalized = normalizeGroqModelId(modelId).toLowerCase();
  return normalized.includes("qwen");
}

export function isGroqGptOssModel(modelId: string): boolean {
  return normalizeGroqModelId(modelId).startsWith("openai/gpt-oss");
}

/** Inject Groq-specific reasoning params into chat/completions request body. */
export function injectGroqReasoningRequestBody(
  body: Record<string, unknown>,
  modelId: string,
): void {
  const normalized = normalizeGroqModelId(modelId);

  if (isGroqGptOssModel(normalized)) {
    // Mutually exclusive with reasoning_format per Groq API.
    body.include_reasoning = true;
    return;
  }

  if (isGroqQwenModel(normalized)) {
    // Required when tools or JSON mode are enabled; parsed exposes delta.reasoning.
    body.reasoning_format = "parsed";
    if (body.reasoning_effort == null) {
      body.reasoning_effort = "default";
    }
  }
}

/** Extract reasoning text from a Groq SSE chunk (pre-AI-SDK Zod strip). */
export function extractGroqReasoningDelta(rawValue: unknown): string | null {
  if (typeof rawValue !== "object" || rawValue === null) {
    return null;
  }

  const choices = (rawValue as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }

  const first = choices[0];
  if (typeof first !== "object" || first === null) {
    return null;
  }

  const delta = (first as { delta?: unknown }).delta;
  if (typeof delta !== "object" || delta === null) {
    return null;
  }

  const reasoning = (delta as { reasoning?: unknown }).reasoning;
  return typeof reasoning === "string" && reasoning.length > 0
    ? reasoning
    : null;
}

/** Wrap fetch to inject Groq reasoning options on chat/completions POSTs. */
export function createGroqFetch(
  modelId: string,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  const normalizedModelId = normalizeGroqModelId(modelId);

  return async (input, init) => {
    let nextInit = init;

    if (
      init?.method === "POST" &&
      typeof init.body === "string" &&
      isGroqChatCompletionsRequest(input)
    ) {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        injectGroqReasoningRequestBody(body, normalizedModelId);
        nextInit = { ...init, body: JSON.stringify(body) };
      } catch {
        // Keep original request if body is not JSON.
      }
    }

    return baseFetch(input, nextInit);
  };
}

function isGroqChatCompletionsRequest(input: string | URL | Request): boolean {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  return url.includes(GROQ_CHAT_COMPLETIONS_PATH);
}

export interface CreateGroqChatModelOptions {
  apiKey: string;
  baseURL?: string;
  headers?: Record<string, string>;
}

/** Create an AI SDK chat model with Groq reasoning request + stream fixes applied. */
export async function createGroqChatModel(
  modelId: string,
  options: CreateGroqChatModelOptions,
): Promise<LanguageModel> {
  const { createOpenAI } = await import("@ai-sdk/openai");
  const normalized = normalizeGroqModelId(modelId);

  const groq = createOpenAI({
    baseURL: options.baseURL ?? "https://api.groq.com/openai/v1",
    apiKey: options.apiKey,
    headers: options.headers,
    fetch: createGroqFetch(normalized),
  });

  return groq.chat(normalized) as LanguageModel;
}

/**
 * Adapt AI SDK fullStream for Groq: emit reasoning-delta from raw SSE chunks
 * because @ai-sdk/openai strips delta.reasoning during Zod validation.
 */
export async function* adaptGroqAISDKFullStream(
  fullStream: AsyncIterable<unknown>,
): AsyncGenerator<unknown> {
  let reasoningActive = false;

  for await (const chunk of fullStream) {
    if (typeof chunk === "object" && chunk !== null && "type" in chunk) {
      const typed = chunk as {
        type?: unknown;
        rawValue?: unknown;
        text?: unknown;
      };

      if (typed.type === "raw") {
        const reasoning = extractGroqReasoningDelta(typed.rawValue);
        if (reasoning) {
          if (!reasoningActive) {
            reasoningActive = true;
            yield { type: "reasoning-start" };
          }
          yield { type: "reasoning-delta", text: reasoning };
        }
      }

      if (
        reasoningActive &&
        (typed.type === "text-delta" ||
          typed.type === "text-end" ||
          typed.type === "tool-call")
      ) {
        reasoningActive = false;
        yield { type: "reasoning-end" };
      }
    }

    yield chunk;
  }

  if (reasoningActive) {
    yield { type: "reasoning-end" };
  }
}
