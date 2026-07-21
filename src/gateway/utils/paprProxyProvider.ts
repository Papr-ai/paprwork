/**
 * Papr AI Proxy Provider
 *
 * Creates AI SDK provider instances that route through the Papr Memory proxy
 * (memory.papr.ai/v1/ai/{provider}/...) instead of directly to OpenAI/Anthropic/Google.
 *
 * This allows users without their own API keys to use LLMs via their Papr API key.
 * The proxy authenticates via X-API-Key header and forwards requests transparently.
 *
 * Usage:
 *   const model = createProxyModel("openai", "gpt-5.4", paprApiKey);
 *   // Works exactly like openai("gpt-5.4") but routes through Papr
 */

import type { LanguageModel } from "ai";
import {
  normalizeOpenAIModelId,
  normalizeGoogleModelId,
} from "./modelNormalizer.js";
import { normalizeZaiModelId } from "./zaiModel.js";

const PAPR_PROXY_BASE =
  process.env.PAPR_AI_PROXY_BASE_URL || "https://memory.papr.ai/v1/ai";

/**
 * Create an AI SDK LanguageModel that routes through the Papr proxy.
 */
export async function createProxyModel(
  provider: string,
  modelId: string,
  paprApiKey: string,
): Promise<LanguageModel> {
  const headers = { "X-API-Key": paprApiKey };

  switch (provider) {
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      const proxy = createAnthropic({
        baseURL: `${PAPR_PROXY_BASE}/anthropic`,
        apiKey: "papr-proxy", // Required by SDK but ignored by proxy
        headers,
      });
      return proxy(modelId) as LanguageModel;
    }

    case "openai":
    case "openai-codex": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const proxy = createOpenAI({
        baseURL: `${PAPR_PROXY_BASE}/openai`,
        apiKey: "papr-proxy",
        headers,
      });
      const normalizedModel = normalizeOpenAIModelId(modelId);
      if (normalizedModel.startsWith("gpt-5")) {
        return proxy.responses(normalizedModel) as LanguageModel;
      }
      return proxy(normalizedModel) as LanguageModel;
    }

    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      const proxy = createGoogleGenerativeAI({
        baseURL: `${PAPR_PROXY_BASE}/google`,
        apiKey: "papr-proxy",
        headers,
      });
      return proxy(normalizeGoogleModelId(modelId)) as LanguageModel;
    }

    case "zai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const proxy = createOpenAI({
        baseURL: `${PAPR_PROXY_BASE}/zai`,
        apiKey: "papr-proxy",
        headers,
      });
      return proxy.chat(normalizeZaiModelId(modelId)) as LanguageModel;
    }

    case "groq": {
      const { createGroqChatModel } = await import("./groqProvider.js");
      const { normalizeGroqModelId } = await import("./groqModel.js");
      return createGroqChatModel(normalizeGroqModelId(modelId), {
        apiKey: "papr-proxy",
        baseURL: `${PAPR_PROXY_BASE}/groq`,
        headers,
      });
    }

    case "moonshot": {
      const { createMoonshotChatModel } = await import("./moonshotProvider.js");
      const { normalizeMoonshotModelId } = await import("./moonshotModel.js");
      return createMoonshotChatModel(normalizeMoonshotModelId(modelId), {
        apiKey: "papr-proxy",
        baseURL: `${PAPR_PROXY_BASE}/moonshot`,
        headers,
      });
    }

    default:
      throw new Error(`Papr proxy does not support provider: ${provider}`);
  }
}
