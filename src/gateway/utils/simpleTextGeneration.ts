/**
 * Simple text generation for background tasks (summaries, titles, etc.)
 * OAuth → pi-ai (subscription APIs). API keys → AI SDK (Platform APIs).
 */

import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import { generateText } from "ai";

export type SimpleTextProvider = "anthropic" | "openai" | "google";

export interface SimpleTextSelection {
  provider: SimpleTextProvider;
  modelIds: readonly string[];
  token: string;
  authType: "oauth" | "apiKey";
}

const ANTHROPIC_MODELS = ["claude-haiku-4-5"] as const;
const OPENAI_API_KEY_MODELS = ["gpt-5-nano", "gpt-4o-mini"] as const;
const OPENAI_OAUTH_MODELS = ["gpt-5.4-mini", "gpt-5.1-codex-mini"] as const;
const GOOGLE_MODELS = ["gemini-2.0-flash-lite"] as const;

type PiAiProvider = "anthropic" | "openai-codex";

/**
 * Resolve provider with Anthropic (Haiku) first, then OpenAI, then Google.
 */
export async function resolveSimpleTextProvider(): Promise<SimpleTextSelection | null> {
  const { getProviderAuth, getApiKeys } = await import("./keyResolver.js");

  const anthropicAuth = await getProviderAuth("anthropic");
  if (anthropicAuth) {
    return {
      provider: "anthropic",
      modelIds: ANTHROPIC_MODELS,
      token: anthropicAuth.type === "oauth" ? anthropicAuth.token : anthropicAuth.key,
      authType: anthropicAuth.type,
    };
  }

  const openaiAuth = await getProviderAuth("openai");
  if (openaiAuth) {
    const modelIds =
      openaiAuth.type === "oauth" ? OPENAI_OAUTH_MODELS : OPENAI_API_KEY_MODELS;
    return {
      provider: "openai",
      modelIds,
      token: openaiAuth.type === "oauth" ? openaiAuth.token : openaiAuth.key,
      authType: openaiAuth.type,
    };
  }

  try {
    const keys = await getApiKeys(["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"]);
    const googleKey = keys.GOOGLE_GENERATIVE_AI_API_KEY || keys.GOOGLE_API_KEY;
    if (googleKey) {
      return {
        provider: "google",
        modelIds: GOOGLE_MODELS,
        token: googleKey,
        authType: "apiKey",
      };
    }
  } catch {
    // No Google key
  }

  return null;
}

function extractAssistantText(message: AssistantMessage): string | null {
  const text = message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  return text || null;
}

async function generateWithPiAi(
  selection: SimpleTextSelection,
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  maxOutputTokens: number,
  logPrefix: string,
): Promise<string | null> {
  if (selection.provider === "google") {
    return null;
  }

  try {
    const { getModel, completeSimple } = await import("@mariozechner/pi-ai");

    const piProvider: PiAiProvider =
      selection.provider === "openai" ? "openai-codex" : "anthropic";
    const envKey =
      selection.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";

    process.env[envKey] = selection.token;

    const piModel = (getModel as (provider: string, id: string) => ReturnType<typeof getModel>)(
      piProvider,
      modelId,
    );
    if (!piModel) {
      console.warn(`${logPrefix} pi-ai model not found: ${piProvider}/${modelId}`);
      return null;
    }

    const message = await completeSimple(
      piModel,
      {
        systemPrompt,
        messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
      },
      { maxTokens: maxOutputTokens },
    );

    if (message.stopReason === "error" || message.stopReason === "aborted") {
      console.warn(
        `${logPrefix} pi-ai ${piProvider}/${modelId} failed:`,
        message.errorMessage ?? message.stopReason,
      );
      return null;
    }

    return extractAssistantText(message);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`${logPrefix} pi-ai ${selection.provider}/${modelId} failed:`, message);
    return null;
  }
}

async function generateWithAiSdk(
  provider: SimpleTextProvider,
  apiKey: string,
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  maxOutputTokens: number,
  logPrefix: string,
): Promise<string | null> {
  try {
    if (provider === "openai") {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const client = createOpenAI({ apiKey });
      const result = await generateText({
        model: client(modelId),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        maxOutputTokens,
      });
      return result.text.trim() || null;
    }

    if (provider === "anthropic") {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      const client = createAnthropic({ apiKey });
      const result = await generateText({
        model: client(modelId),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        maxOutputTokens,
      });
      return result.text.trim() || null;
    }

    const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
    const client = createGoogleGenerativeAI({ apiKey });
    const result = await generateText({
      model: client(modelId),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      maxOutputTokens,
    });
    return result.text.trim() || null;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`${logPrefix} ${provider}/${modelId} failed:`, message);
    return null;
  }
}

/**
 * Generate text using the cheapest available provider.
 * OAuth routes through pi-ai; API keys use AI SDK.
 */
export async function generateSimpleText(
  systemPrompt: string,
  userPrompt: string,
  maxOutputTokens: number,
  logPrefix = "[SimpleText]",
): Promise<string | null> {
  const selection = await resolveSimpleTextProvider();
  if (!selection) {
    console.warn(`${logPrefix} No provider available`);
    return null;
  }

  for (const modelId of selection.modelIds) {
    console.log(
      `${logPrefix} Using ${selection.provider}/${modelId} (${selection.authType})`,
    );

    const result =
      selection.authType === "oauth"
        ? await generateWithPiAi(
            selection,
            modelId,
            systemPrompt,
            userPrompt,
            maxOutputTokens,
            logPrefix,
          )
        : await generateWithAiSdk(
            selection.provider,
            selection.token,
            modelId,
            systemPrompt,
            userPrompt,
            maxOutputTokens,
            logPrefix,
          );

    if (result) {
      return result;
    }
  }

  return null;
}
