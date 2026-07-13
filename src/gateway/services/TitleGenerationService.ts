/**
 * Title Generation Service
 *
 * Generates concise chat titles using AI models.
 * OAuth → pi-ai (subscription APIs). API keys → AI SDK (Platform APIs).
 * Anthropic Haiku preferred over OpenAI when both are available.
 */

import { generateSimpleText } from "../utils/simpleTextGeneration.js";

const SYSTEM_PROMPT = `Generate a concise title that summarizes the user's message. Rules:
- Maximum 40 characters
- No quotes, colons, or prefixes like "Here is" or "Title:"
- Just return the title directly
- Make it descriptive and clear
- Use title case`;

export class TitleGenerationService {
  /**
   * Generate a concise title from the first user message.
   */
  async generateTitle(firstMessage: string): Promise<string> {
    try {
      const userPrompt = firstMessage.substring(0, 500);

      const result = await generateSimpleText(
        SYSTEM_PROMPT,
        userPrompt,
        30,
        "[TitleGen]",
      );

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
   * Fallback title generation (smart truncation)
   */
  private fallbackTitle(message: string): string {
    let title = message.replace(/\n/g, " ").replace(/\s+/g, " ").trim();

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
      title =
        lastSpace > 20
          ? truncated.substring(0, lastSpace) + "..."
          : truncated + "...";
    }

    return title || "New Chat";
  }
}
