/**
 * Hybrid Storage Provider
 *
 * Combines LocalStorageProvider + PaprMemoryProvider for best of both worlds:
 * - Fast local cache for instant UI
 * - Cloud sync for backup and cross-device
 * - Graceful fallback if PAPR unavailable
 */

import type {
  IStorageProvider,
  StoredMessage,
  StoredSummary,
  ChatMetadata,
} from "./IStorageProvider";
import { LocalStorageProvider } from "./LocalStorageProvider.js";
import { PaprMemoryProvider, type PaprConfig } from "./PaprMemoryProvider.js";
import { reportPaprQuotaError } from "../../../core/utils/paprQuota.js";

export class HybridStorageProvider implements IStorageProvider {
  private local: LocalStorageProvider;
  private papr: PaprMemoryProvider;
  private syncEnabled: boolean;

  constructor(localPath: string, paprConfig: PaprConfig) {
    this.local = new LocalStorageProvider(localPath);
    this.papr = new PaprMemoryProvider(paprConfig);
    this.syncEnabled = true;
  }

  async initialize(): Promise<void> {
    await this.local.initialize();
    // PAPR doesn't need initialization
  }

  /** Local SQLite provider (tool-call patches, direct reads). */
  getLocalProvider(): LocalStorageProvider {
    return this.local;
  }

  patchDelegateTaskToolResult(
    chatId: string,
    delegationRunId: string,
    update: {
      status: "completed" | "failed";
      resultText?: string;
      error?: string;
      completedAt?: string;
    },
  ): boolean {
    return this.local.patchDelegateTaskToolResult(
      chatId,
      delegationRunId,
      update,
    );
  }

  /** Sidecar payloads are local files, so this always goes to SQLite. */
  readOffloadedToolResult(
    chatId: string,
    messageId: string,
    toolCallId: string,
  ): Promise<string | null> {
    return this.local.readOffloadedToolResult(chatId, messageId, toolCallId);
  }

  // ===== Message Operations =====

  async updateMessage(
    chatId: string,
    messageId: string,
    message: StoredMessage,
  ): Promise<void> {
    const isIncomplete = message.incomplete === true;

    // Checkpoints (incomplete) are local-only — no cloud traffic during
    // streaming. The FINAL update (incomplete=false, same row) syncs to
    // PAPR exactly once, same as a fresh saveMessage would.
    await this.local.updateMessage(chatId, messageId, {
      ...message,
      sync_status: isIncomplete ? "local" : "sync_pending",
    });

    if (this.syncEnabled && !isIncomplete) {
      this.syncMessageToPapr(chatId, message).catch((err) => {
        console.error(`Failed to sync message ${message.id} to PAPR:`, err);
        reportPaprQuotaError(err, "chat-sync");
        this.local.markSyncFailed(message.id, err.message);
      });
    }
  }

  async saveMessage(chatId: string, message: StoredMessage): Promise<void> {
    // Incomplete messages (interrupted-turn checkpoints/partials) stay
    // local-only: don't pollute PAPR memory with half-finished turns.
    // If the turn later completes, the final save (complete message,
    // same stable ID lineage) syncs normally.
    const isIncomplete = message.incomplete === true;

    // 1. ALWAYS save locally first (fast, reliable)
    await this.local.saveMessage(chatId, {
      ...message,
      sync_status: isIncomplete ? "local" : "sync_pending",
    });

    // 2. Sync to PAPR in background (non-blocking)
    if (this.syncEnabled && !isIncomplete) {
      this.syncMessageToPapr(chatId, message).catch((err) => {
        console.error(`Failed to sync message ${message.id} to PAPR:`, err);
        reportPaprQuotaError(err, "chat-sync");
        this.local.markSyncFailed(message.id, err.message);
      });
    }
  }

  private async syncMessageToPapr(
    chatId: string,
    message: StoredMessage,
  ): Promise<void> {
    try {
      // Save to PAPR
      await this.papr.saveMessage(chatId, message);

      // Mark as synced in local DB
      if (message.papr_message_id) {
        await this.local.markMessageSynced(message.id, message.papr_message_id);
      }
    } catch (error) {
      throw error;
    }
  }

  async loadMessages(
    chatId: string,
    limit?: number,
    skip?: number,
  ): Promise<StoredMessage[]> {
    // LOCAL-FIRST STRATEGY: Always load from local SQLite (source of truth)
    // This prevents missing messages when PAPR sync is incomplete or delayed.
    // PAPR sync for assistant messages can fail silently (large payloads with
    // tool calls, thinking, etc.), leaving PAPR with only user messages.
    // Using local-first ensures the UI always shows all messages.
    const localMessages = await this.local.loadMessages(chatId, limit, skip);

    // If sync disabled or local has messages, use local
    if (!this.syncEnabled || localMessages.length > 0) {
      return localMessages;
    }

    // Local is empty — try PAPR as fallback (e.g., cross-device scenario)
    try {
      const paprMessages = await this.papr.loadMessages(chatId, limit, skip);
      if (paprMessages.length > 0) {
        return paprMessages;
      }
    } catch (error) {
      console.warn("[HybridStorage] PAPR fallback failed:", error);
    }

    return localMessages;
  }

  async loadMessagesForLLM(chatId: string): Promise<any[]> {
    // LOCAL-FIRST STRATEGY: Always load from local (source of truth)
    // This prevents race conditions where PAPR doesn't have latest messages yet
    const localMessages = await this.local.loadMessagesForLLM(chatId);

    // If sync disabled, return local only
    if (!this.syncEnabled) {
      return localMessages;
    }

    // If sync enabled, fetch PAPR summary and merge with local messages
    try {
      const paprData = await this.papr.loadMessagesForLLM(chatId);

      const localHasSummary = localMessages.some(
        (item: unknown) =>
          typeof item === "object" &&
          item !== null &&
          "__summary" in (item as Record<string, unknown>),
      );

      // Local summary is authoritative — avoid duplicate __summary blocks (confuses the model)
      if (localHasSummary) {
        return localMessages;
      }

      // Extract summary from PAPR (if it exists)
      const summaryItem = paprData.find((item: any) => item.__summary);

      if (summaryItem) {
        const localWithoutSummary = localMessages.filter(
          (item: unknown) =>
            typeof item !== "object" ||
            item === null ||
            !("__summary" in (item as Record<string, unknown>)),
        );
        console.log(
          `[HybridStorage] Using PAPR summary + ${localWithoutSummary.length} local messages`,
        );
        return [summaryItem, ...localWithoutSummary];
      }

      // No summary from PAPR, check if PAPR has messages from other devices
      const localMessageIds = new Set(
        localMessages.map((m: any) => m.id || m.papr_message_id),
      );

      // Find messages in PAPR but not in local (from other devices)
      const crossDeviceMessages = paprData.filter(
        (m: any) =>
          !m.__summary &&
          (m.id || m.papr_message_id) &&
          !localMessageIds.has(m.id || m.papr_message_id),
      );

      if (crossDeviceMessages.length > 0) {
        console.log(
          `[HybridStorage] Merging ${crossDeviceMessages.length} cross-device messages from PAPR`,
        );
        // Merge and sort by timestamp
        const merged = [...localMessages, ...crossDeviceMessages];
        merged.sort(
          (a: any, b: any) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );
        return merged;
      }

      // PAPR has no new data, use local only
      return localMessages;
    } catch (error) {
      reportPaprQuotaError(error, "chat-load");
      console.warn(
        "[HybridStorage] PAPR fetch failed, using local only:",
        error,
      );
      return localMessages;
    }
  }

  // ===== Summary Operations =====

  async fetchAndCacheSummary(chatId: string): Promise<StoredSummary | null> {
    if (!this.syncEnabled) {
      // Sync disabled, use local only
      return this.local.fetchAndCacheSummary(chatId);
    }

    try {
      // Ensure PAPR has the latest messages before compressing
      await this.bulkSyncToPapr(chatId);

      // 1. Fetch from PAPR (retrieveHistory cache first, then /compress)
      const summary = await this.papr.fetchAndCacheSummary(chatId);

      if (summary) {
        // 2. Cache in local SQLite for offline access
        await this.local.saveSummary(chatId, summary);
        return summary;
      }

      return null;
    } catch (error) {
      reportPaprQuotaError(error, "chat-compress");
      console.error("PAPR compress failed, using local fallback:", error);

      // 3. Fallback to local LLM generation (if implemented)
      return this.local.fetchAndCacheSummary(chatId);
    }
  }

  async getSummary(chatId: string): Promise<StoredSummary | null> {
    // Cache-only read — callers that need a fresh summary use fetchAndCacheSummary().
    return this.local.getSummary(chatId);
  }

  async saveSummary(chatId: string, summary: StoredSummary): Promise<void> {
    // Save to local cache
    await this.local.saveSummary(chatId, summary);

    // PAPR generates summaries automatically, no manual save needed
  }

  // ===== Chat Operations =====

  async createChat(chatId: string, title?: string): Promise<void> {
    // Create locally
    await this.local.createChat(chatId, title);

    // PAPR creates chat automatically on first message
  }

  async updateChat(
    chatId: string,
    updates: Partial<{ title: string; memory_scope: import("./IStorageProvider.js").ChatMemoryScope }>,
  ): Promise<void> {
    // Update locally
    await this.local.updateChat(chatId, updates);

    // Sync to PAPR if enabled
    if (this.syncEnabled && updates.title) {
      try {
        await this.papr.updateChat(chatId, updates);
      } catch (error) {
        console.error("Failed to sync chat update to PAPR:", error);
      }
    }
  }

  async deleteChat(chatId: string): Promise<void> {
    // Delete locally
    await this.local.deleteChat(chatId);

    // Note: PAPR doesn't support deletion (intentional data retention)
  }

  async listChats(): Promise<ChatMetadata[]> {
    // Use local list (PAPR doesn't have list endpoint)
    return this.local.listChats();
  }

  async listRecentChatSummaries(
    limit: number,
    maxAgeDays: number,
  ): Promise<import("./IStorageProvider.js").ChatSummarySnapshot[]> {
    return this.local.listRecentChatSummaries(limit, maxAgeDays);
  }

  // ===== Sync Operations =====

  async markMessageSynced(
    messageId: string,
    paprObjectId: string,
  ): Promise<void> {
    await this.local.markMessageSynced(messageId, paprObjectId);
  }

  async markSyncFailed(messageId: string, error: string): Promise<void> {
    await this.local.markSyncFailed(messageId, error);
  }

  async getUnsyncedMessages(chatId: string): Promise<StoredMessage[]> {
    return this.local.getUnsyncedMessages(chatId);
  }

  async getChatSyncStats(chatId: string) {
    return this.local.getChatSyncStats(chatId);
  }

  async getChatStats(chatId: string): Promise<{
    message_count: number;
    token_count: number;
    cost_total: number;
    has_summary: boolean;
  }> {
    // Use local stats (faster)
    return this.local.getChatStats(chatId);
  }

  async getChatCost(chatId: string): Promise<{
    total: number;
    byModel: Record<string, number>;
    messageCount: number;
    avgCostPerMessage: number;
  }> {
    return this.local.getChatCost(chatId);
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
    return this.local.getGlobalCostStats();
  }

  async getDailyCostTrends(
    days?: number,
  ): Promise<
    Array<{ date: string; cost: number; messages: number; tokens: number }>
  > {
    return this.local.getDailyCostTrends(days);
  }

  async getModelDistribution(): Promise<
    Array<{ model: string; percentage: number; cost: number; messages: number }>
  > {
    return this.local.getModelDistribution();
  }

  async getAgentStats(agentId: string): Promise<{
    totalMessages: number;
    totalTokens: number;
    totalCost: number;
    toolCallsCount: number;
    avgTokensPerMessage: number;
    avgCostPerMessage: number;
    mostUsedTools: Array<{ tool: string; count: number }>;
  }> {
    return this.local.getAgentStats(agentId);
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
    return this.local.getAllAgentStats();
  }

  async getAgentOutputs(agentId?: string): Promise<{
    documents: Array<{ id: string; title: string; createdAt: string }>;
    apps: Array<{ id: string; title: string; createdAt: string }>;
    plans: Array<{ planId: string; title: string; createdAt: string }>;
  }> {
    // Use local for agent outputs (tracked locally)
    return this.local.getAgentOutputs(agentId);
  }

  getContextEfficiencyStats() {
    return this.local.getContextEfficiencyStats();
  }

  getToolUsageByAgent(): Record<
    string,
    {
      mostUsedTools: Array<{ tool: string; count: number }>;
      totalToolInvocations: number;
    }
  > {
    return this.local.getToolUsageByAgent();
  }

  // ===== Sync Management =====

  /**
   * Bulk sync unsynced messages to PAPR
   * Used when enabling cloud after local-only use
   */
  async bulkSyncToPapr(chatId: string): Promise<{
    total: number;
    synced: number;
    failed: number;
  }> {
    const unsynced = await this.getUnsyncedMessages(chatId);
    let synced = 0;
    let failed = 0;

    for (const message of unsynced) {
      try {
        await this.syncMessageToPapr(chatId, message);
        synced++;
      } catch (error) {
        failed++;
        reportPaprQuotaError(error, "chat-bulk-sync");
        console.error(`Failed to sync message ${message.id}:`, error);
      }
    }

    return {
      total: unsynced.length,
      synced,
      failed,
    };
  }

  /**
   * Enable or disable sync
   */
  setSyncEnabled(enabled: boolean): void {
    this.syncEnabled = enabled;
  }

  /**
   * Check if sync is enabled
   */
  isSyncEnabled(): boolean {
    return this.syncEnabled;
  }
}
