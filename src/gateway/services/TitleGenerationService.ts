/**
 * Title Generation Service
 *
 * Generates concise chat titles using gpt-5-mini-2025-08-07.
 * Handles both OAuth (via pi-ai) and API key (via AI SDK) routing.
 * Based on Paprwork V1's title generation logic.
 */

import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";

export class TitleGenerationService {
  /**
   * Generate a concise title from the first user message
   * Uses gpt-5-mini-2025-08-07 for fast, cheap title generation
   * 
   * Handles OAuth routing: If user is using OpenAI OAuth, routes to pi-ai
   * Otherwise uses AI SDK with API key
   */
  async generateTitle(firstMessage: string): Promise<string> {
    try {
      // Check if using OAuth or API key (same logic as chat)
      const { getProviderAuth } = await import("../utils/keyResolver.js");
      const auth = await getProviderAuth("openai");

      if (!auth) {
        console.log("[TitleGenerationService] No OpenAI auth available, using fallback");
        return this.fallbackTitle(firstMessage);
      }

      const systemPrompt = `Generate a concise title that summarizes the user's message. Rules:
- Maximum 40 characters
- No quotes, colons, or prefixes like "Here is" or "Title:"
- Just return the title directly
- Make it descriptive and clear
- Use title case`;

      const userPrompt = firstMessage.substring(0, 500); // Limit input for efficiency

      let text: string;

      if (auth.type === "oauth") {
        // OAuth: Route to pi-ai (ChatGPT backend)
        console.log("[TitleGenerationService] Using OpenAI OAuth via pi-ai");
        
        const { getModel, streamSimple } = await import("@mariozechner/pi-ai");
        
        // Set token in environment (pi-ai reads from env)
        process.env.OPENAI_API_KEY = auth.token;
        
        // Get pi-ai model
        const piModel = getModel("openai-codex", "gpt-5.2");
        
        // Build messages for pi-ai
        const messages = [
          {
            role: "user" as const,
            content: `${systemPrompt}\n\n${userPrompt}`,
            timestamp: Date.now(),
          },
        ];
        
        // Stream response from pi-ai
        const stream = streamSimple(piModel, { 
          messages,
          tools: undefined,
        });
        
        // Collect text from stream
        let collectedText = "";
        for await (const event of stream) {
          if (event.type === "text_delta" && event.delta) {
            collectedText += event.delta;
          }
          if (event.type === "done") {
            break;
          }
          if (event.type === "error") {
            const errorMsg = (event as any).error?.errorMessage || "pi-ai streaming error";
            throw new Error(errorMsg);
          }
        }
        
        text = collectedText;
      } else {
        // API Key: Use AI SDK
        console.log("[TitleGenerationService] Using OpenAI API key via AI SDK");
        process.env.OPENAI_API_KEY = auth.key;

        const model = openai("gpt-5-mini-2025-08-07");

        const result = await generateText({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        });

        text = result.text;
      }

      const title = text.trim();

      // Validate and return
      if (title && title.length > 0 && title.length <= 100) {
        return title.substring(0, 40); // Enforce max length
      }

      // If AI returned something weird, use fallback
      return this.fallbackTitle(firstMessage);
    } catch (error: any) {
      console.warn("Failed to generate AI title:", error.message);
      return this.fallbackTitle(firstMessage);
    }
  }

  /**
   * Fallback title generation (simple truncation)
   * Used when AI fails or returns invalid title
   */
  private fallbackTitle(message: string): string {
    // Clean up the message
    let title = message
      .replace(/\n/g, " ") // Remove newlines
      .replace(/\s+/g, " ") // Collapse multiple spaces
      .trim();

    // Remove common prefixes
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
        // Capitalize first letter
        title = title.charAt(0).toUpperCase() + title.slice(1);
        break;
      }
    }

    // Truncate if too long
    if (title.length > 40) {
      // Try to break at word boundary
      const truncated = title.substring(0, 40);
      const lastSpace = truncated.lastIndexOf(" ");

      if (lastSpace > 20) {
        title = truncated.substring(0, lastSpace) + "...";
      } else {
        title = truncated + "...";
      }
    }

    return title || "New Chat";
  }

}
