/**
 * Title Generation Service
 *
 * Generates concise chat titles using AI models.
 * Handles both OAuth (via pi-ai) and API key (via AI SDK) routing.
 * Supports OpenAI (gpt-5-mini) and Anthropic (claude-3.5-haiku).
 * Based on Paprwork V1's title generation logic.
 */

import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";

export class TitleGenerationService {
  /**
   * Generate a concise title from the first user message
   * Uses gpt-5-mini-2025-08-07 (OpenAI) or claude-3.5-haiku (Claude)
   * 
   * Handles OAuth routing: If user is using OAuth, routes to pi-ai
   * Otherwise uses AI SDK with API key
   */
  async generateTitle(firstMessage: string): Promise<string> {
    try {
      // Check auth availability (prioritizes OAuth, falls back to API key)
      const { getProviderAuth } = await import("../utils/keyResolver.js");
      
      // Try OpenAI first (cheaper)
      let auth = await getProviderAuth("openai");
      let provider: "openai" | "anthropic" = "openai";
      
      // If no OpenAI auth, try Claude
      if (!auth) {
        auth = await getProviderAuth("anthropic");
        provider = "anthropic";
      }

      if (!auth) {
        console.log("[TitleGenerationService] No AI auth available, using fallback");
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
        // OAuth: Route to pi-ai (ChatGPT/Claude backend)
        console.log(`[TitleGenerationService] Using ${provider} OAuth via pi-ai`);
        
        const { getModel, streamSimple } = await import("@mariozechner/pi-ai");
        
        // Set token in environment (pi-ai reads from env)
        if (provider === "openai") {
          process.env.OPENAI_API_KEY = auth.token;
        } else {
          process.env.ANTHROPIC_API_KEY = auth.token;
        }
        
        // Get pi-ai model (openai-codex for ChatGPT, anthropic for Claude)
        const modelType = provider === "openai" ? "openai-codex" : "anthropic";
        const modelName = provider === "openai" ? "gpt-5.2" : "claude-3-5-sonnet-20241022";
        const piModel = getModel(modelType as any, modelName as any);
        
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
        console.log(`[TitleGenerationService] Using ${provider} API key via AI SDK`);
        
        if (provider === "openai") {
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
        } else {
          // Claude
          process.env.ANTHROPIC_API_KEY = auth.key;
          const model = anthropic("claude-3-5-haiku-20241022");
          
          const result = await generateText({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
          });
          
          text = result.text;
        }
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
