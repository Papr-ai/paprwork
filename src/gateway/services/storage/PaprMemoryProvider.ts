/**
 * PAPR Memory Provider
 *
 * Integrates with PAPR Memory API for cloud storage and auto-summarization.
 * Uses PAPR's /messages endpoint for storage and /compress for summaries.
 *
 * Now using official @papr/memory SDK v2.0.0
 */

import Papr from "@papr/memory";
import type {
  IStorageProvider,
  StoredMessage,
  StoredSummary,
  ChatMetadata,
} from "./IStorageProvider";

export interface PaprConfig {
  apiKey: string; // X-API-Key from macOS Keychain
}

export class PaprMemoryProvider implements IStorageProvider {
  private client: Papr;
  // Expose client for testing
  public get _client() {
    return this.client;
  }

  constructor(config: PaprConfig) {
    this.client = new Papr({
      xAPIKey: config.apiKey, // X-API-Key header from macOS Keychain
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
      // Build customMetadata: only string | number | boolean | Array<string> allowed
      // This goes in metadata.customMetadata per the MemoryMetadata SDK type
      const customMetadata: Record<
        string,
        string | number | boolean | Array<string>
      > = {
        sourceAgentId: message.source_agent_id || "main-agent",
        sourceAgentName: message.source_agent_name || "Paprwork Assistant",
        model: message.model || "unknown",
      };

      if (message.toolCalls && message.toolCalls.length > 0) {
        // Array<string> is allowed
        customMetadata.toolsUsed = message.toolCalls.map((tc) => tc.name);
        customMetadata.toolCallsCount = message.toolCalls.length;
      }

      if (message.thinking) {
        customMetadata.hasThinking = true;
        customMetadata.thinkingLength = message.thinking.length;
      }

      if (message.prompt_tokens) {
        customMetadata.promptTokens = message.prompt_tokens;
        customMetadata.completionTokens = message.completion_tokens ?? 0;
        customMetadata.totalTokens = message.total_tokens ?? 0;
      }

      if (message.error) {
        customMetadata.hasError = true;
      }

      if (message.incomplete) {
        customMetadata.incomplete = true;
      }

      // POST to PAPR /v1/messages using SDK
      const response = await this.client.messages.store({
        content: message.content,
        role: message.role,
        sessionId: chatId,
        process_messages: true, // Let PAPR do batch analysis & auto-summarize
        metadata: {
          // Typed MemoryMetadata fields
          conversationId: chatId,
          createdAt: message.timestamp,
          role: message.role,
          // Custom fields in their proper container
          customMetadata,
        },
      });

      // Store the PAPR objectId in the message
      message.papr_message_id = response.objectId;
      message.sync_status = "synced";
    } catch (error) {
      if (error instanceof Papr.AuthenticationError) {
        console.error("Invalid PAPR_API_KEY - check Settings");
        throw new Error("Invalid PAPR API key. Please check your Settings.");
      } else if (error instanceof Papr.RateLimitError) {
        console.error("PAPR Memory quota exceeded. Please upgrade your account.");
        throw new Error(
          "PAPR Memory quota exceeded. Please upgrade your account at https://platform.papr.ai/settings"
        );
      } else if (error instanceof Papr.PermissionDeniedError) {
        console.error("PAPR Memory access denied - quota may be exceeded.");
        throw new Error(
          "PAPR Memory access denied. Your account may have exceeded its quota. Please upgrade at https://platform.papr.ai/settings"
        );
      }
      throw error;
    }
  }

  async loadMessages(
    chatId: string,
    limit = 100,
    skip = 0,
  ): Promise<StoredMessage[]> {
    try {
      // GET from PAPR /v1/messages/sessions/{sessionId} using SDK
      const response = await this.client.messages.sessions.retrieveHistory(
        chatId,
        {
          limit,
          skip,
        },
      );

      // IMPORTANT: PAPR returns messages in REVERSE chronological order (newest first)
      // Reverse to chronological order (oldest first) for UI display
      return response.messages.reverse().map((msg) => ({
        id: msg.objectId,
        chat_id: chatId,
        role: msg.role,
        content:
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content),
        timestamp: msg.createdAt,
        sync_status: "synced" as const,
        papr_message_id: msg.objectId,
      }));
    } catch (error) {
      console.error("Failed to load messages from PAPR:", error);
      return [];
    }
  }

  async loadMessagesForLLM(chatId: string): Promise<any[]> {
    try {
      // Get messages and check for summary using SDK
      const response =
        await this.client.messages.sessions.retrieveHistory(chatId);

      console.log(`[PaprMemoryProvider] 📥 Retrieved ${response.messages?.length || 0} messages from PAPR for chat ${chatId}`);
      console.log(`[PaprMemoryProvider] 📊 Total count: ${response.total_count}, Has summary: ${!!response.summaries}`);
      
      // Log first and last messages to check ordering
      if (response.messages && response.messages.length > 0) {
        const first = response.messages[0] as any;
        const last = response.messages[response.messages.length - 1] as any;
        console.log(`[PaprMemoryProvider] 🔍 First message: [${first.timestamp || first.createdAt}] ${first.role}`);
        console.log(`[PaprMemoryProvider] 🔍 Last message: [${last.timestamp || last.createdAt}] ${last.role}`);
      }

      if (response.context_for_llm) {
        // PAPR provides pre-formatted context
        const summary = response.summaries;
        // Keep last 50 messages for proper recent context
        // IMPORTANT: PAPR returns messages in REVERSE chronological order (newest first)
        // We need to reverse them to chronological order (oldest first) for LLM
        const recentMessages = response.messages.slice(-50).reverse();
        
        console.log(`[PaprMemoryProvider] 📤 Returning ${recentMessages.length} recent messages (reversed to chronological order)`);
        
        // Log first and last after reversing to verify order
        if (recentMessages.length > 0) {
          const first = recentMessages[0] as any;
          const last = recentMessages[recentMessages.length - 1] as any;
          console.log(`[PaprMemoryProvider] ✅ After reverse - First: [${first.timestamp || first.createdAt}], Last: [${last.timestamp || last.createdAt}]`);
        }

        if (summary) {
          // Format summary for system prompt (NOT as a user message)
          const summaryForSystemPrompt = this.formatSummaryForLLM(
            summary,
            response.total_count,
            recentMessages.length,
            chatId,
          );

          // Inject summary as special __summary property for AgentService to extract
          return [
            { __summary: summaryForSystemPrompt },
            ...recentMessages.map((m: any) => ({
              role: m.role,
              content: m.content,
              timestamp: m.timestamp || m.createdAt, // Preserve timestamp if available
            })),
          ];
        }
      }

      // No summary, return all messages
      // IMPORTANT: PAPR returns messages in REVERSE chronological order (newest first)
      // Reverse to chronological order (oldest first) for LLM
      return response.messages.reverse().map((m: any) => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp || m.createdAt, // Preserve timestamp if available
      }));
    } catch (error) {
      console.error("Failed to load messages for LLM:", error);
      return [];
    }
  }

  private formatSummaryForLLM(
    summary: any,
    totalCount: number,
    recentCount: number,
    chatId: string,
  ): string {
    const archivedCount = totalCount - recentCount;
    const chatFilePath = `~/Papr/Chats/${chatId}.txt`;

    return `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📚 ARCHIVED CONVERSATION SUMMARY (${archivedCount} older messages archived)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

This conversation has been ongoing for ${totalCount} messages total.
The summary below covers the first ${archivedCount} messages.
The actual recent ${recentCount} messages follow this summary in the conversation history.

Full conversation export: ${chatFilePath}
You can use bash/grep/read tools to search the full history if needed.

───────────────────────────────────────────────────────────

FULL SESSION SUMMARY:
${summary.long_term}

RECENT CONTEXT (last ~100 messages):
${summary.medium_term}

CURRENT BATCH (last 15 messages):
${summary.short_term}

KEY TOPICS: ${summary.topics?.join(", ") || "N/A"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  }

  // ===== Summary Operations =====

  async fetchAndCacheSummary(chatId: string): Promise<StoredSummary | null> {
    try {
      // Call PAPR compress endpoint using SDK
      const response = await this.client.messages.sessions.compress(chatId);

      if (response.summaries) {
        return {
          short_term: response.summaries.short_term || "",
          medium_term: response.summaries.medium_term || "",
          long_term: response.summaries.long_term || "",
          topics: response.summaries.topics || [],
          last_updated:
            response.summaries.last_updated || new Date().toISOString(),
          fetched_from_papr: true,
          last_fetched_at: new Date().toISOString(),
        };
      }

      return null;
    } catch (error) {
      console.error("Failed to fetch summary from PAPR:", error);
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

  async updateChat(
    chatId: string,
    updates: Partial<{ title: string }>,
  ): Promise<void> {
    // Note: PAPR SDK v2.0.0 doesn't expose a dedicated updateChat endpoint
    // Title can be set when storing first message
    if (updates.title) {
      console.log(
        `Chat title update requested for ${chatId}: ${updates.title}`,
      );
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

  async markMessageSynced(
    _messageId: string,
    _paprObjectId: string,
  ): Promise<void> {
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
    cost_total: number;
    has_summary: boolean;
  }> {
    try {
      const response = await this.client.messages.sessions.retrieveHistory(
        chatId,
        {
          limit: 1,
        },
      );

      return {
        message_count: response.total_count || 0,
        token_count: 0, // PAPR doesn't expose token count
        cost_total: 0, // PAPR doesn't expose cost
        has_summary: !!response.summaries?.short_term,
      };
    } catch (error) {
      return {
        message_count: 0,
        token_count: 0,
        cost_total: 0,
        has_summary: false,
      };
    }
  }

  async getChatCost(_chatId: string): Promise<{
    total: number;
    byModel: Record<string, number>;
    messageCount: number;
    avgCostPerMessage: number;
  }> {
    // PAPR doesn't provide cost data
    return {
      total: 0,
      byModel: {},
      messageCount: 0,
      avgCostPerMessage: 0,
    };
  }

  async getGlobalCostStats(): Promise<{
    today: number;
    thisWeek: number;
    thisMonth: number;
    total: number;
    totalMessages: number;
    topModels: Array<{ model: string; cost: number; count: number }>;
  }> {
    // PAPR doesn't provide global cost stats
    return {
      today: 0,
      thisWeek: 0,
      thisMonth: 0,
      total: 0,
      totalMessages: 0,
      topModels: [],
    };
  }

  async getDailyCostTrends(
    _days?: number,
  ): Promise<Array<{ date: string; cost: number; messages: number }>> {
    // PAPR doesn't provide cost trends
    return [];
  }

  async getModelDistribution(): Promise<
    Array<{ model: string; percentage: number; cost: number; messages: number }>
  > {
    // PAPR doesn't provide model distribution
    return [];
  }

  async getAgentStats(_agentId: string): Promise<{
    totalMessages: number;
    totalTokens: number;
    totalCost: number;
    toolCallsCount: number;
    avgTokensPerMessage: number;
    avgCostPerMessage: number;
    mostUsedTools: Array<{ tool: string; count: number }>;
  }> {
    // PAPR doesn't provide agent stats
    return {
      totalMessages: 0,
      totalTokens: 0,
      totalCost: 0,
      toolCallsCount: 0,
      avgTokensPerMessage: 0,
      avgCostPerMessage: 0,
      mostUsedTools: [],
    };
  }

  async getAgentOutputs(_agentId?: string): Promise<{
    documents: Array<{ id: string; title: string; createdAt: string }>;
    apps: Array<{ id: string; title: string; createdAt: string }>;
    plans: Array<{ planId: string; title: string; createdAt: string }>;
  }> {
    // PAPR doesn't track agent outputs
    return {
      documents: [],
      apps: [],
      plans: [],
    };
  }
}
