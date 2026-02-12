/**
 * Title Generation Service
 * 
 * Generates concise chat titles using gpt-5-mini-2025-08-07.
 * Based on Paprwork V1's title generation logic.
 */

import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

export class TitleGenerationService {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Generate a concise title from the first user message
   * Uses gpt-5-mini-2025-08-07 for fast, cheap title generation
   */
  async generateTitle(firstMessage: string): Promise<string> {
    try {
      // Set OpenAI API key
      process.env.OPENAI_API_KEY = this.apiKey;
      
      // Use gpt-5-mini for title generation (fast & cheap)
      // Use Responses API for GPT-5 models
      const model = openai.responses('gpt-5-mini');

      const { text } = await generateText({
        model,
        messages: [
          {
            role: 'system',
            content: `Generate a concise title that summarizes the user's message. Rules:
- Maximum 40 characters
- No quotes, colons, or prefixes like "Here is" or "Title:"
- Just return the title directly
- Make it descriptive and clear
- Use title case`,
          },
          {
            role: 'user',
            content: firstMessage.substring(0, 500), // Limit input for efficiency
          },
        ],
        // Note: temperature not supported for reasoning models like gpt-5-mini
        // Note: maxTokens/maxCompletionTokens not needed - model will auto-limit
      });

      const title = text.trim();
      
      // Validate and return
      if (title && title.length > 0 && title.length <= 100) {
        return title.substring(0, 40); // Enforce max length
      }
      
      // If AI returned something weird, use fallback
      return this.fallbackTitle(firstMessage);
      
    } catch (error: any) {
      console.warn('Failed to generate AI title:', error.message);
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
      .replace(/\n/g, ' ')           // Remove newlines
      .replace(/\s+/g, ' ')           // Collapse multiple spaces
      .trim();

    // Remove common prefixes
    const prefixes = [
      'can you ',
      'could you ',
      'please ',
      'i want to ',
      'i need to ',
      'how do i ',
      'how can i ',
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
      const lastSpace = truncated.lastIndexOf(' ');
      
      if (lastSpace > 20) {
        title = truncated.substring(0, lastSpace) + '...';
      } else {
        title = truncated + '...';
      }
    }

    return title || 'New Chat';
  }

  /**
   * Update API key (when user changes settings)
   */
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }
}
