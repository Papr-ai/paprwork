/**
 * Title Generation Service
 *
 * Generates concise chat titles using AI models.
 * Uses process.env keys (set by the streaming auth flow) as primary,
 * falls back to keyResolver for standalone calls.
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
   * Called AFTER streaming completes, so process.env keys are guaranteed set.
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
   * Uses process.env (already set by the stream's auth resolver) first,
   * then falls back to keyResolver IPC.
   */
  private async tryGenerateWithAvailableProvider(
    userPrompt: string,
  ): Promise<string | null> {
    // 1. Try OpenAI (from env - set by stream auth)
    if (process.env.OPENAI_API_KEY) {
      try {
        console.log("[TitleGen] Trying OpenAI (from env)");
        const { createOpenAI } = await import("@ai-sdk/openai");
        const client = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const result = await generateText({
          model: client("gpt-4o-mini"),
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          maxOutputTokens: 30,
        });
        return result.text;
      } catch (err: unknown) {
        console.warn("[TitleGen] OpenAI failed:", err instanceof Error ? err.message : String(err));
      }
    }

    // 2. Try Anthropic (from env - set by stream auth)
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        console.log("[TitleGen] Trying Anthropic (from env)");
        const { createAnthropic } = await import("@ai-sdk/anthropic");
        const client = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const result = await generateText({
          model: client("claude-haiku-4-5"),
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          maxOutputTokens: 30,
        });
        return result.text;
      } catch (err: unknown) {
        console.warn("[TitleGen] Anthropic failed:", err instanceof Error ? err.message : String(err));
      }
    }

    // 3. Try Google (from env - set by stream auth)
    const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY;
    if (googleKey) {
      try {
        console.log("[TitleGen] Trying Google (from env)");
        const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
        const client = createGoogleGenerativeAI({ apiKey: googleKey });
        const result = await generateText({
          model: client("gemini-2.0-flash"),
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          maxOutputTokens: 30,
        });
        return result.text;
      } catch (err: unknown) {
        console.warn("[TitleGen] Google failed:", err instanceof Error ? err.message : String(err));
      }
    }

    // 4. Last resort: try keyResolver IPC (for edge cases where env not yet set)
    try {
      console.log("[TitleGen] Trying keyResolver fallback");
      const { getProviderAuth } = await import("../utils/keyResolver.js");
      for (const provider of ["openai", "anthropic"] as const) {
        const auth = await getProviderAuth(provider);
        if (!auth) continue;

        const token = auth.type === "oauth" ? auth.token : auth.key;
        console.log(`[TitleGen] Using ${provider} via keyResolver (${auth.type})`);

        if (provider === "openai") {
          const { createOpenAI } = await import("@ai-sdk/openai");
          const client = createOpenAI({ apiKey: token });
          const result = await generateText({
            model: client("gpt-4o-mini"),
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userPrompt },
            ],
            maxOutputTokens: 30,
          });
          return result.text;
        } else {
          const { createAnthropic } = await import("@ai-sdk/anthropic");
          const client = createAnthropic({ apiKey: token });
          const result = await generateText({
            model: client("claude-haiku-4-5"),
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userPrompt },
            ],
            maxOutputTokens: 30,
          });
          return result.text;
        }
      }
    } catch (err: unknown) {
      console.warn("[TitleGen] keyResolver fallback failed:", err instanceof Error ? err.message : String(err));
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
