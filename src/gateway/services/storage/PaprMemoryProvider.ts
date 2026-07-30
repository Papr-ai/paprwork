/**
 * PAPR Memory Provider
 *
 * Integrates with PAPR Memory API for cloud storage and auto-summarization.
 * Uses PAPR's /messages endpoint for storage and /compress for summaries.
 *
 * Now using official @papr/memory SDK v2.0.0
 */

import Papr from "@papr/memory";
import { handlePaprToolError } from "../../../core/tools/paprClient.js";
import type {
  IStorageProvider,
  StoredMessage,
  StoredSummary,
  ChatMetadata,
} from "./IStorageProvider";
import {
  extractEnhancedFields,
  formatSummaryForLLM,
} from "./summaryFormatting.js";
import { RECENT_MESSAGES_MAX } from "./recentMessageWindow.js";
import path from "path";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import { formatPaprPathForAgent } from "../../../core/utils/paprAgentPaths.js";
import {
  buildPaprSyncStoreBody,
  type PaprMessageStoreBody,
} from "./paprSyncPayload.js";
import { buildPaprMemoryWriteScope } from "../../utils/memoryScopeResolver.js";

export interface PaprConfig {
  apiKey: string; // X-API-Key from macOS Keychain
}

const PAPR_COMPRESS_BACKOFF_MS = 10 * 60 * 1000;

function formatPaprCompressError(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  ) {
    const apiError = error as { status: number; headers?: Headers };
    const requestId = apiError.headers?.get("x-request-id");
    return requestId
      ? `${apiError.status} (request-id: ${requestId})`
      : `${apiError.status}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export class PaprMemoryProvider implements IStorageProvider {
  private client: Papr;
  /** Skip repeated /compress calls after a server error (shared across chats). */
  private static compressBackoffUntil = 0;
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

  async updateMessage(
    _chatId: string,
    _messageId: string,
    _message: StoredMessage,
  ): Promise<void> {
    // No-op for PAPR cloud — checkpoints are local-only.
    // The final saveMessage call will push the complete message.
  }

  async saveMessage(chatId: string, message: StoredMessage): Promise<void> {
    try {
      const memoryScope = await buildPaprMemoryWriteScope({ chatId });
      const storeBody: PaprMessageStoreBody = buildPaprSyncStoreBody({
        chatId,
        message,
        externalUserId: memoryScope.external_user_id,
        namespaceId: memoryScope.namespace_id,
        policy: memoryScope.policy,
      });

      const response = await this.client.messages.store(
        storeBody as Parameters<Papr["messages"]["store"]>[0],
      );

      // Store the PAPR objectId in the message
      message.papr_message_id = response.objectId;
      message.sync_status = "synced";
    } catch (error) {
      if (error instanceof Papr.AuthenticationError) {
        console.error("Invalid PAPR_API_KEY - check Settings");
      }
      handlePaprToolError(error, "papr-memory-save");
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

      // PAPR returns newest first (-createdAt order), reverse to chronological for UI
      return response.messages.reverse().map((msg) => {
        // Handle three content formats:
        // 1. Old format: JSON string '{"text": "...", "thinking": "...", "toolCalls": [...]}'
        // 2. New format: structured array [{type: "thinking",...}, {type: "text",...}, {type: "tool_use",...}]
        // 3. Plain string: regular text content

        let textContent = "";
        let thinking: string | undefined;
        let toolCalls: any[] | undefined;
        let sequence: any[] | undefined;
        let model: string | undefined;

        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          // New structured format from PAPR (unwrapped from {type:"structured", data:[...]})
          for (const item of msg.content as any[]) {
            if (item.type === "text" && item.text) textContent += item.text;
            if (item.type === "thinking" && item.thinking) thinking = item.thinking;
            if (item.type === "tool_use") {
              if (!toolCalls) toolCalls = [];
              toolCalls.push({
                id: item.id,
                name: item.name,
                args: item.input,
              });
            }
          }
          // Check for sequence/model stored as extra properties on the content object
          const rawContent = (msg as any).content;
          if (rawContent?.sequence) sequence = rawContent.sequence;
          if (rawContent?.model) model = rawContent.model;
        } else if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.startsWith("{")) {
          // Old format: serialized rich content JSON string
          try {
            const obj = JSON.parse(msg.content);
            if (obj.text !== undefined) {
              textContent = obj.text;
              thinking = obj.thinking;
              toolCalls = obj.toolCalls;
              sequence = obj.sequence;
              model = obj.model;
            } else {
              textContent = msg.content;
            }
          } catch {
            textContent = msg.content;
          }
        } else {
          textContent = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        }

        return {
          id: msg.objectId,
          chat_id: chatId,
          role: msg.role,
          content: textContent,
          thinking,
          toolCalls,
          sequence,
          model,
          timestamp: msg.createdAt,
          sync_status: "synced" as const,
          papr_message_id: msg.objectId,
        };
      });
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
        // PAPR returns newest first; cap at MAX (local hybrid uses chunked window)
        const recentMessages = response.messages
          .slice(0, RECENT_MESSAGES_MAX)
          .reverse();
        
        console.log(`[PaprMemoryProvider] 📤 Returning ${recentMessages.length} recent messages`);
        
        if (recentMessages.length > 0) {
          const first = recentMessages[0] as any;
          const last = recentMessages[recentMessages.length - 1] as any;
          console.log(`[PaprMemoryProvider] ✅ First: [${first.timestamp || first.createdAt}] ${first.role}, Last: [${last.timestamp || last.createdAt}] ${last.role}`);
        }

        if (summary) {
          const enhanced = extractEnhancedFields(response);
          const summaryForSystemPrompt = formatSummaryForLLM({
            tiers: {
              short_term: summary.short_term ?? "",
              medium_term: summary.medium_term ?? "",
              long_term: summary.long_term ?? "",
              topics: summary.topics ?? [],
              last_updated:
                summary.last_updated ?? new Date().toISOString(),
            },
            enhanced,
            chatFilePath: formatPaprPathForAgent(
              path.join(getPaprRoot(), "Chats", `${chatId}.txt`),
            ),
          });

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

      // No summary — reverse from newest-first to chronological for LLM
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


  // ===== Summary Operations =====

  async fetchAndCacheSummary(chatId: string): Promise<StoredSummary | null> {
    if (Date.now() < PaprMemoryProvider.compressBackoffUntil) {
      return null;
    }

    try {
      // Prefer cached summaries from retrieveHistory before on-demand /compress.
      // PAPR auto-generates summaries every ~15 messages; /compress is heavier
      // and can 500 on very large tool-heavy sessions.
      const history = await this.client.messages.sessions.retrieveHistory(
        chatId,
        { limit: 1 },
        { maxRetries: 0 },
      );

      if (history.summaries?.long_term) {
        PaprMemoryProvider.compressBackoffUntil = 0;
        const s = history.summaries;
        return {
          short_term: s.short_term || "",
          medium_term: s.medium_term || "",
          long_term: s.long_term || "",
          topics: s.topics || [],
          last_updated: s.last_updated || new Date().toISOString(),
          enhanced: extractEnhancedFields(history),
          fetched_from_papr: true,
          last_fetched_at: new Date().toISOString(),
        };
      }

      // On-demand compress when no cached summary exists
      const response = await this.client.messages.sessions.compress(chatId, {
        maxRetries: 0,
      });

      if (response.summaries) {
        PaprMemoryProvider.compressBackoffUntil = 0;
        const s = response.summaries;
        return {
          short_term: s.short_term || "",
          medium_term: s.medium_term || "",
          long_term: s.long_term || "",
          topics: s.topics || [],
          last_updated: s.last_updated || new Date().toISOString(),
          enhanced: extractEnhancedFields(response),
          fetched_from_papr: true,
          last_fetched_at: new Date().toISOString(),
        };
      }

      return null;
    } catch (error) {
      const status =
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        typeof (error as { status: unknown }).status === "number"
          ? (error as { status: number }).status
          : 0;

      if (status >= 500 || status === 429) {
        PaprMemoryProvider.compressBackoffUntil =
          Date.now() + PAPR_COMPRESS_BACKOFF_MS;
      }

      console.warn(
        `[PaprMemory] /compress failed for ${chatId}: ${formatPaprCompressError(error)}` +
          (status >= 500 || status === 429
            ? ` — backing off ${PAPR_COMPRESS_BACKOFF_MS / 60000}m`
            : ""),
      );
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

  async listRecentChatSummaries(
    _limit: number,
    _maxAgeDays: number,
  ): Promise<import("./IStorageProvider.js").ChatSummarySnapshot[]> {
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
    totalTokens: number;
    todayTokens: number;
    thisWeekTokens: number;
    thisMonthTokens: number;
    totalMessages: number;
    topModels: Array<{
      model: string;
      cost: number;
      tokens: number;
      count: number;
    }>;
  }> {
    // PAPR doesn't provide global cost stats
    return {
      today: 0,
      thisWeek: 0,
      thisMonth: 0,
      total: 0,
      totalTokens: 0,
      todayTokens: 0,
      thisWeekTokens: 0,
      thisMonthTokens: 0,
      totalMessages: 0,
      topModels: [],
    };
  }

  async getDailyCostTrends(
    _days?: number,
  ): Promise<
    Array<{ date: string; cost: number; messages: number; tokens: number }>
  > {
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

  async getAllAgentStats(): Promise<
    Record<
      string,
      {
        totalMessages: number;
        totalTokens: number;
        totalCost: number;
        toolCallsCount: number;
        avgTokensPerMessage: number;
        avgCostPerMessage: number;
        mostUsedTools: Array<{ tool: string; count: number }>;
      }
    >
  > {
    return {};
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

  getToolUsageByAgent(): Record<
    string,
    {
      mostUsedTools: Array<{ tool: string; count: number }>;
      totalToolInvocations: number;
    }
  > {
    return {};
  }

  getContextEfficiencyStats() {
    return {
      fullChatTokensPerTurn: 0,
      agentContextTokensPerTurn: 0,
      truncationTokensSaved: 0,
      summaryTokensSaved: 0,
      memorySearchTokensSaved: 0,
      totalTokensSaved: 0,
      totalTokensConsumed: 0,
      hypotheticalTokensWithoutOptimizations: 0,
      lifetimeTokensSaved: 0,
      contextInflationRatio: 1,
      efficiencyScore: 0,
      actualCost: 0,
      hypotheticalCostWithoutOptimizations: 0,
      lifetimeCostSaved: 0,
      costEfficiencyScore: 0,
      dataSource: "live" as const,
      pendingFootprintTurns: 0,
      breakdown: {
        chatsAnalyzed: 0,
        chatsWithSummaries: 0,
        assistantTurnsAnalyzed: 0,
        memorySearchCount: 0,
        hybridBashCount: 0,
        memoryHitsAnalyzed: 0,
        memoryHitsWithSource: 0,
        fullReadAvgTokens: 0,
        memorySearchAvgTokens: 0,
      },
    };
  }
}
