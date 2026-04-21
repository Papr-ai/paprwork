/**
 * Title Generation Service
 *
 * Generates concise chat titles using AI models.
 * Uses the same auth resolution as chat (getProviderAuth) but always uses AI SDK
 * (OAuth tokens work fine with AI SDK for simple non-streaming calls like title generation)
 */

import { generateText } from "ai";

const SYSTEM_PROMPT = `Generate a concise title that summarizes the user's message. Rules:
- Maximum 40 characters
- No quotes, colons, or prefixes like "Here is" or "Title:"
- Just return the title directly
- Make it descriptive and clear
- Use title case`;

export class TitleGenerationService {
  /**
   * Generate a concise title from the first user message.
   * Uses getProviderAuth() to match chat routing (OAuth vs API key)
   */
  async generateTitle(firstMessage: string): Promise<string> {
    try {
      const userPrompt = firstMessage.substring(0, 500);

      const result = await this.tryGenerateWithAvailableProvider(userPrompt);
      if (result) {
        const title = result.trim();
        if (title && title.length > 0 && title.length <= 100) {
          console.log(`[TitleGen] Generated: "${title.substring(0, 40)}"`);
          return title.substring(0, 40);
        }
      }

      console.log("[TitleGen] No provider succeeded, using fallback");
      return this.fallbackTitle(firstMessage);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[TitleGen] AI generation failed:", message);
      return this.fallbackTitle(firstMessage);
    }
  }

  /**
   * Try each available provider until one succeeds.
   * Uses getProviderAuth() just like chat (same routing logic)
   * NOTE: Uses AI SDK for both OAuth and API key - OAuth tokens work fine with AI SDK
   * for simple non-streaming calls like title generation
   */
  private async tryGenerateWithAvailableProvider(
    userPrompt: string,
  ): Promise<string | null> {
    // Get provider auth to match chat routing
    const { getProviderAuth } = await import("../utils/keyResolver.js");

    // Try OpenAI first
    const openaiAuth = await getProviderAuth("openai");
    if (openaiAuth) {
      const token = openaiAuth.type === "oauth" ? openaiAuth.token : openaiAuth.key;
      
      console.log(`[TitleGen] Using OpenAI (${openaiAuth.type})`);
      
      const result = await this.generateWithAiSdk("openai", token, userPrompt);
      if (result) return result;
    }

    // Try Anthropic second
    const anthropicAuth = await getProviderAuth("anthropic");
    if (anthropicAuth) {
      const token = anthropicAuth.type === "oauth" ? anthropicAuth.token : anthropicAuth.key;
      
      console.log(`[TitleGen] Using Anthropic (${anthropicAuth.type})`);
      
      const result = await this.generateWithAiSdk("anthropic", token, userPrompt);
      if (result) return result;
    }

    // Try Google (API key only, no OAuth)
    try {
      const { getApiKeys } = await import("../utils/keyResolver.js");
      const keys = await getApiKeys(["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"]);
      const googleKey = keys.GOOGLE_GENERATIVE_AI_API_KEY || keys.GOOGLE_API_KEY;
      
      if (googleKey) {
        console.log("[TitleGen] Using Google (API key)");
        const result = await this.generateWithAiSdk("google", googleKey, userPrompt);
        if (result) return result;
      }
    } catch (err: unknown) {
      console.warn("[TitleGen] Google auth failed:", err instanceof Error ? err.message : String(err));
    }

    return null;
  }

  /**
   * Generate title using AI SDK
   * Works for both OAuth tokens and API keys
   */
  private async generateWithAiSdk(
    provider: "openai" | "anthropic" | "google",
    apiKey: string,
    userPrompt: string,
  ): Promise<string | null> {
    try {
      if (provider === "openai") {
        const { createOpenAI } = await import("@ai-sdk/openai");
        const client = createOpenAI({ apiKey });
        const result = await generateText({
          model: client("gpt-4o-mini"),
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          maxOutputTokens: 30,
        });
        return result.text;
      } else if (provider === "anthropic") {
        const { createAnthropic } = await import("@ai-sdk/anthropic");
        const client = createAnthropic({ apiKey });
        const result = await generateText({
          model: client("claude-haiku-4-5"),
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          maxOutputTokens: 30,
        });
        return result.text;
      } else if (provider === "google") {
        const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
        const client = createGoogleGenerativeAI({ apiKey });
        const result = await generateText({
          model: client("gemini-2.0-flash"),
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          maxOutputTokens: 30,
        });
        return result.text;
      }
    } catch (err: unknown) {
      console.warn(`[TitleGen] ${provider} (AI SDK) failed:`, err instanceof Error ? err.message : String(err));
    }
    
    return null;
  }


  /**
   * Fallback title generation (smart truncation)
   */
  private fallbackTitle(message: string): string {
    let title = message.replace(/\n/g, " ").replace(/\s+/g, " ").trim();

    const prefixes = [
      "can you ", "could you ", "please ", "i want to ",
      "i need to ", "how do i ", "how can i ",
    ];

    const lowerTitle = title.toLowerCase();
    for (const prefix of prefixes) {
      if (lowerTitle.startsWith(prefix)) {
        title = title.substring(prefix.length);
        title = title.charAt(0).toUpperCase() + title.slice(1);
        break;
      }
    }

    if (title.length > 40) {
      const truncated = title.substring(0, 40);
      const lastSpace = truncated.lastIndexOf(" ");
      title = lastSpace > 20
        ? truncated.substring(0, lastSpace) + "..."
        : truncated + "...";
    }

    return title || "New Chat";
  }
}
