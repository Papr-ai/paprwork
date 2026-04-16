/**
 * Title Generation Service
 *
 * Generates concise chat titles using AI models.
 * Uses AI SDK directly with OAuth tokens or API keys.
 */

import { openai, createOpenAI } from "@ai-sdk/openai";
import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";

const SYSTEM_PROMPT = `Generate a concise title that summarizes the user's message. Rules:
- Maximum 40 characters
- No quotes, colons, or prefixes like "Here is" or "Title:"
- Just return the title directly
- Make it descriptive and clear
- Use title case`;

export class TitleGenerationService {
  /**
   * Generate a concise title from the first user message
   */
  async generateTitle(firstMessage: string): Promise<string> {
    try {
      const { getProviderAuth } = await import("../utils/keyResolver.js");

      // Try OpenAI first (cheaper/faster), then Anthropic
      let auth = await getProviderAuth("openai");
      let provider: "openai" | "anthropic" = "openai";

      if (!auth) {
        auth = await getProviderAuth("anthropic");
        provider = "anthropic";
      }

      if (!auth) {
        console.log("[TitleGen] No auth available, using fallback");
        return this.fallbackTitle(firstMessage);
      }

      const userPrompt = firstMessage.substring(0, 500);
      const token = auth.type === "oauth" ? auth.token : auth.key;

      console.log(`[TitleGen] Using ${provider} (${auth.type})`);

      let text: string;

      if (provider === "openai") {
        const client = createOpenAI({ apiKey: token });
        const result = await generateText({
          model: client("gpt-4o-mini"),
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          maxTokens: 30,
        });
        text = result.text;
      } else {
        const client = createAnthropic({ apiKey: token });
        const result = await generateText({
          model: client("claude-3-5-haiku-20241022"),
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          maxTokens: 30,
        });
        text = result.text;
      }

      const title = text.trim();

      if (title && title.length > 0 && title.length <= 100) {
        console.log(`[TitleGen] Generated: "${title.substring(0, 40)}"`);
        return title.substring(0, 40);
      }

      return this.fallbackTitle(firstMessage);
    } catch (error: any) {
      console.warn("[TitleGen] AI generation failed:", error.message);
      return this.fallbackTitle(firstMessage);
    }
  }

  /**
   * Fallback title generation (simple truncation)
   */
  private fallbackTitle(message: string): string {
    let title = message
      .replace(/\n/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const prefixes = [
      "can you ",
      "could you ",
      "please ",
      "i want to ",
      "i need to ",
      "how do i ",
      "how can i ",
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
