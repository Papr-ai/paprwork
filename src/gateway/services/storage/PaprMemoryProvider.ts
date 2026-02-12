/**
 * PAPR Memory Provider
 * 
 * Integrates with PAPR Memory API for cloud storage and auto-summarization.
 * Uses PAPR's /messages endpoint for storage and /compress for summaries.
 * 
 * Now using official @papr/memory SDK v2.0.0
 */

import Papr from '@papr/memory';
import type {
  IStorageProvider,
  StoredMessage,
  StoredSummary,
  ChatMetadata,
} from './IStorageProvider';

export interface PaprConfig {
  apiKey: string;       // X-API-Key from macOS Keychain
  baseUrl?: string;     // Optional custom base URL
}

export class PaprMemoryProvider implements IStorageProvider {
  private client: Papr;
  // Expose client for testing
  public get _client() { return this.client; }

  constructor(config: PaprConfig) {
    this.client = new Papr({
      xAPIKey: config.apiKey,  // X-API-Key header from macOS Keychain
      baseURL: config.baseUrl,
      maxRetries: 3,
      timeout: 30000, // 30 seconds
    });
  }

  async initialize(): Promise<void> {
    // No initialization needed for API-only mode
  }

  // ===== Message Operations =====

  async saveMessage(chatId: string, message: StoredMessage): Promise<void> {
    try {
      // POST to PAPR /v1/messages using SDK
      const response = await this.client.messages.store({
        content: message.content,
        role: message.role,
        sessionId: chatId,
        process_messages: true, // Let PAPR do batch analysis & auto-summarize
        metadata: {
          conversationId: chatId,
          createdAt: message.timestamp,
        },
      });

      // Store the PAPR objectId in the message
      message.papr_message_id = response.objectId;
      message.sync_status = 'synced';
    } catch (error) {
      if (error instanceof Papr.AuthenticationError) {
        console.error('Invalid PAPR_API_KEY - check Settings');
      } else if (error instanceof Papr.RateLimitError) {
        console.error('PAPR rate limit exceeded, retrying...');
      }
      throw error;
    }
  }

  async loadMessages(chatId: string, limit = 100, skip = 0): Promise<StoredMessage[]> {
    try {
      // GET from PAPR /v1/messages/sessions/{sessionId} using SDK
      const response = await this.client.messages.sessions.retrieveHistory(chatId, {
        limit,
        skip,
      });

      return response.messages.map((msg) => ({
        id: msg.objectId,
        chat_id: chatId,
        role: msg.role,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        timestamp: msg.createdAt,
        sync_status: 'synced' as const,
        papr_message_id: msg.objectId,
      }));
    } catch (error) {
      console.error('Failed to load messages from PAPR:', error);
      return [];
    }
  }

  async loadMessagesForLLM(chatId: string): Promise<any[]> {
    try {
      // Get messages and check for summary using SDK
      const response = await this.client.messages.sessions.retrieveHistory(chatId);

      if (response.context_for_llm) {
        // PAPR provides pre-formatted context
        const summary = response.summaries;
        const recentMessages = response.messages.slice(-6); // Last 6 messages

        if (summary) {
          return [
            {
              role: 'user',
              content: this.formatSummaryForLLM(summary, response.total_count, 6, chatId)
            },
            ...recentMessages.map((m) => ({
              role: m.role,
              content: m.content
            }))
          ];
        }
      }

      // No summary, return all messages
      return response.messages.map((m) => ({
        role: m.role,
        content: m.content
      }));
    } catch (error) {
      console.error('Failed to load messages for LLM:', error);
      return [];
    }
  }

  private formatSummaryForLLM(summary: any, totalCount: number, recentCount: number, chatId: string): string {
    const archivedCount = totalCount - recentCount;
    const chatFilePath = `~/PAPR/Chats/${chatId}.txt`;

    return `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📚 ARCHIVED CONVERSATION SUMMARY (${archivedCount} older messages)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠️  CRITICAL INSTRUCTIONS:
• DO NOT respond to this summary
• DO NOT ask questions about the summary  
• FOCUS on the ${recentCount} RECENT messages below
• Full conversation history: ${chatFilePath}
• Use bash/grep/read tools if you need specific details from older messages

───────────────────────────────────────────────────────────

FULL SESSION: ${summary.long_term}

RECENT CONTEXT (last ~100 messages): ${summary.medium_term}

CURRENT BATCH (last 15 messages): ${summary.short_term}

KEY TOPICS: ${summary.topics?.join(', ') || 'N/A'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[END OF ARCHIVED CONTEXT]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The following ${recentCount} messages are the RECENT conversation.`;
  }

  // ===== Summary Operations =====

  async fetchAndCacheSummary(chatId: string): Promise<StoredSummary | null> {
    try {
      // Call PAPR compress endpoint using SDK
      const response = await this.client.messages.sessions.compress(chatId);

      if (response.summaries) {
        return {
          short_term: response.summaries.short_term || '',
          medium_term: response.summaries.medium_term || '',
          long_term: response.summaries.long_term || '',
          topics: response.summaries.topics || [],
          last_updated: response.summaries.last_updated || new Date().toISOString(),
          fetched_from_papr: true,
          last_fetched_at: new Date().toISOString(),
        };
      }

      return null;
    } catch (error) {
      console.error('Failed to fetch summary from PAPR:', error);
      return null;
    }
  }

  async getSummary(chatId: string): Promise<StoredSummary | null> {
    // For PAPR-only mode, always fetch fresh
    return this.fetchAndCacheSummary(chatId);
  }

  async saveSummary(_chatId: string, _summary: StoredSummary): Promise<void> {
    // PAPR generates summaries automatically
    // No need to save manually
  }

  // ===== Chat Operations =====

  async createChat(chatId: string, title?: string): Promise<void> {
    // PAPR creates chat automatically when first message is sent
    // Optionally update title
    if (title) {
      await this.updateChat(chatId, { title });
    }
  }

  async updateChat(chatId: string, updates: Partial<{ title: string }>): Promise<void> {
    // Note: PAPR SDK v2.0.0 doesn't expose a dedicated updateChat endpoint
    // Title can be set when storing first message
    if (updates.title) {
      console.log(`Chat title update requested for ${chatId}: ${updates.title}`);
      // TODO: Check if PAPR API supports title updates in future versions
    }
  }

  async deleteChat(chatId: string): Promise<void> {
    // PAPR doesn't support chat deletion via API (intentional - data retention)
    console.warn(`PAPR Memory does not support chat deletion for ${chatId}`);
  }

  async listChats(): Promise<ChatMetadata[]> {
    // PAPR doesn't have a dedicated "list chats" endpoint
    // This would need to be tracked locally
    return [];
  }

  // ===== Sync Operations =====

  async markMessageSynced(_messageId: string, _paprObjectId: string): Promise<void> {
    // Not applicable for PAPR-only mode (messages are already synced)
  }

  async markSyncFailed(_messageId: string, _error: string): Promise<void> {
    // Not applicable for PAPR-only mode
  }

  async getUnsyncedMessages(_chatId: string): Promise<StoredMessage[]> {
    // Not applicable for PAPR-only mode
    return [];
  }

  async getChatStats(chatId: string): Promise<{
    message_count: number;
    token_count: number;
    has_summary: boolean;
  }> {
    try {
      const response = await this.client.messages.sessions.retrieveHistory(chatId, {
        limit: 1
      });

      return {
        message_count: response.total_count || 0,
        token_count: 0, // PAPR doesn't expose token count
        has_summary: !!response.summaries?.short_term,
      };
    } catch (error) {
      return { message_count: 0, token_count: 0, has_summary: false };
    }
  }
}
