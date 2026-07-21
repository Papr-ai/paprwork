/**
 * Cheap summarizer for background tasks (code summaries, etc.)
 * OAuth → pi-ai. API keys → AI SDK. Anthropic Haiku preferred over OpenAI.
 */

import {
  generateSimpleText,
  resolveSimpleTextProvider,
  type SimpleTextProvider,
} from "./simpleTextGeneration.js";

export type CheapSummarizerProvider = SimpleTextProvider;

export interface CheapSummarizerSelection {
  provider: CheapSummarizerProvider;
  modelId: string;
  token: string;
  authType: "oauth" | "apiKey";
}

/**
 * Resolve the cheapest available summarizer for the current user.
 */
export async function resolveCheapSummarizer(): Promise<CheapSummarizerSelection | null> {
  const selection = await resolveSimpleTextProvider();
  if (!selection) {
    return null;
  }

  return {
    provider: selection.provider,
    modelId: selection.modelIds[0],
    token: selection.token,
    authType: selection.authType,
  };
}

/**
 * Generate summary text using the cheapest available provider.
 */
export async function generateCheapSummaryText(
  systemPrompt: string,
  userPrompt: string,
  maxOutputTokens: number,
): Promise<string | null> {
  return generateSimpleText(
    systemPrompt,
    userPrompt,
    maxOutputTokens,
    "[CheapSummarizer]",
  );
}
