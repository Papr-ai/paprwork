/**
 * Moonshot Kimi provider helpers — reasoning_effort injection + stream adaptation.
 *
 * Kimi K3 uses OpenAI-compatible chat/completions with:
 * - Top-level reasoning_effort (only "max" supported)
 * - reasoning_content deltas in streaming responses
 * - Fixed sampling params — omit temperature, top_p, penalties from requests
 */

import type { LanguageModel } from "ai";
import { normalizeMoonshotModelId } from "./moonshotModel.js";

const MOONSHOT_CHAT_COMPLETIONS_PATH = "/chat/completions";

/** Params Kimi K3 rejects — fixed server-side per Moonshot docs. */
const MOONSHOT_STRIP_PARAMS = [
  "temperature",
  "top_p",
  "n",
  "presence_penalty",
  "frequency_penalty",
] as const;

/** Inject Kimi K3 request body fields and strip unsupported sampling params. */
export function injectMoonshotRequestBody(body: Record<string, unknown>): void {
  body.reasoning_effort = "max";

  for (const key of MOONSHOT_STRIP_PARAMS) {
    delete body[key];
  }
}

/** Extract reasoning text from a Moonshot SSE chunk (pre-AI-SDK Zod strip). */
export function extractMoonshotReasoningDelta(rawValue: unknown): string | null {
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

  const reasoningContent = (delta as { reasoning_content?: unknown })
    .reasoning_content;
  return typeof reasoningContent === "string" && reasoningContent.length > 0
    ? reasoningContent
    : null;
}

/** Wrap fetch to inject Moonshot options on chat/completions POSTs. */
export function createMoonshotFetch(
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    let nextInit = init;

    if (
      init?.method === "POST" &&
      typeof init.body === "string" &&
      isMoonshotChatCompletionsRequest(input)
    ) {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        injectMoonshotRequestBody(body);
        nextInit = { ...init, body: JSON.stringify(body) };
      } catch {
        // Keep original request if body is not JSON.
      }
    }

    return baseFetch(input, nextInit);
  };
}

function isMoonshotChatCompletionsRequest(
  input: string | URL | Request,
): boolean {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  return url.includes(MOONSHOT_CHAT_COMPLETIONS_PATH);
}

export interface CreateMoonshotChatModelOptions {
  apiKey: string;
  baseURL?: string;
  headers?: Record<string, string>;
}

/** Create an AI SDK chat model with Kimi K3 request + stream fixes applied. */
export async function createMoonshotChatModel(
  modelId: string,
  options: CreateMoonshotChatModelOptions,
): Promise<LanguageModel> {
  const { createOpenAI } = await import("@ai-sdk/openai");
  const normalized = normalizeMoonshotModelId(modelId);

  const moonshot = createOpenAI({
    baseURL: options.baseURL ?? "https://api.moonshot.ai/v1",
    apiKey: options.apiKey,
    headers: options.headers,
    fetch: createMoonshotFetch(),
  });

  return moonshot.chat(normalized) as LanguageModel;
}

/**
 * Adapt AI SDK fullStream for Moonshot: emit reasoning-delta from raw SSE chunks
 * because @ai-sdk/openai strips delta.reasoning_content during Zod validation.
 */
export async function* adaptMoonshotAISDKFullStream(
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
        const reasoning = extractMoonshotReasoningDelta(typed.rawValue);
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
