/**
 * Storage Manager
 *
 * Manages storage provider initialization and provides unified interface
 * for chat persistence. Handles switching between Local/Papr/Hybrid modes.
 */

import type {
  IStorageProvider,
  StoredMessage,
  StoredSummary,
  ChatMetadata,
  ChatSummarySnapshot,
} from "./storage/IStorageProvider.js";
import { LocalStorageProvider } from "./storage/LocalStorageProvider.js";
import { PaprMemoryProvider } from "./storage/PaprMemoryProvider.js";
import { HybridStorageProvider } from "./storage/HybridStorageProvider.js";
import * as path from "path";
import * as os from "os";

export type StorageMode = "local" | "papr" | "hybrid";

export interface StorageConfig {
  mode: StorageMode;

  // Local storage config
  userDataPath?: string; // Path for SQLite database

  // PAPR config
  paprApiKey?: string;
}

export class StorageManager {
  private provider: IStorageProvider | null = null;
  private currentMode: StorageMode | null = null;
  private config: StorageConfig | null = null;

  /**
   * Initialize storage with specified mode and configuration
   */
  async initialize(config: StorageConfig): Promise<void> {
    this.config = config;
    this.currentMode = config.mode;

    console.log(`[StorageManager] Creating provider for mode: ${config.mode}`);
    // Create appropriate provider based on mode
    switch (config.mode) {
      case "local":
        this.provider = new LocalStorageProvider(
          config.userDataPath || this.getDefaultUserDataPath(),
        );
        break;

      case "papr":
        if (!config.paprApiKey) {
          throw new Error("PAPR API key required for PAPR mode");
        }
        this.provider = new PaprMemoryProvider({
          apiKey: config.paprApiKey,
        });
        break;

      case "hybrid":
        if (!config.paprApiKey) {
          throw new Error("PAPR API key required for Hybrid mode");
        }
        this.provider = new HybridStorageProvider(
          config.userDataPath || this.getDefaultUserDataPath(),
          { apiKey: config.paprApiKey },
        );
        break;

      default:
        throw new Error(`Unknown storage mode: ${config.mode}`);
    }

    console.log(`[StorageManager] Provider created, initializing...`);
    // Initialize the provider
    await this.provider.initialize();
    console.log(`✓ StorageManager initialized in ${config.mode} mode`);
  }

  /**
   * Get default user data path (Electron app data directory)
   */
  private getDefaultUserDataPath(): string {
    // In Electron, this would be app.getPath('userData')
    // For now, use a sensible default
    return path.join(os.homedir(), ".paprwork-v2");
  }

  /**
   * Ensure provider is initialized
   */
  private ensureInitialized(): IStorageProvider {
    if (!this.provider) {
      throw new Error(
        "StorageManager not initialized. Call initialize() first.",
      );
    }
    return this.provider;
  }

  /**
   * Get current provider (for direct access when needed)
   */
  get currentProvider(): IStorageProvider {
    return this.ensureInitialized();
  }

  // ===== Message Operations =====

  /**
   * Save a message to storage
   */
  async saveMessage(chatId: string, message: StoredMessage): Promise<void> {
    const provider = this.ensureInitialized();
    await provider.saveMessage(chatId, message);
  }

  /**
   * Update an existing message in-place (no message_count increment).
   * Used for streaming checkpoint persistence.
   */
  async updateMessage(
    chatId: string,
    messageId: string,
    message: StoredMessage,
  ): Promise<void> {
    const provider = this.ensureInitialized();
    await provider.updateMessage(chatId, messageId, message);
  }

  /**
   * Load all messages for a chat
   */
  async loadMessages(
    chatId: string,
    limit?: number,
    skip?: number,
  ): Promise<StoredMessage[]> {
    const provider = this.ensureInitialized();
    return await provider.loadMessages(chatId, limit, skip);
  }

  /**
   * Update stored delegate_task tool result when a sub-agent job finishes.
   */
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
    const provider = this.ensureInitialized();
    if (provider instanceof LocalStorageProvider) {
      return provider.patchDelegateTaskToolResult(
        chatId,
        delegationRunId,
        update,
      );
    }
    if (provider instanceof HybridStorageProvider) {
      return provider.patchDelegateTaskToolResult(
        chatId,
        delegationRunId,
        update,
      );
    }
    return false;
  }

  /**
   * Load messages formatted for LLM consumption
   * Returns summary + recent messages when appropriate
   */
  async loadMessagesForLLM(chatId: string): Promise<any[]> {
    const provider = this.ensureInitialized();
    return await provider.loadMessagesForLLM(chatId);
  }

  // ===== Chat Operations =====

  /**
   * Create a new chat session
   */
  async createChat(chatId: string, title?: string): Promise<void> {
    const provider = this.ensureInitialized();
    await provider.createChat(chatId, title);
  }

  /**
   * Update chat metadata (title, etc.)
   */
  async updateChat(
    chatId: string,
    updates: Partial<{ title: string }>,
  ): Promise<void> {
    const provider = this.ensureInitialized();
    await provider.updateChat(chatId, updates);
  }

  /**
   * Delete a chat and all its messages
   */
  async deleteChat(chatId: string): Promise<void> {
    const provider = this.ensureInitialized();
    await provider.deleteChat(chatId);
  }

  /**
   * List all chats
   */
  async listChats(): Promise<ChatMetadata[]> {
    const provider = this.ensureInitialized();
    return await provider.listChats();
  }

  async listRecentChatSummaries(
    limit: number,
    maxAgeDays: number,
  ): Promise<ChatSummarySnapshot[]> {
    const provider = this.ensureInitialized();
    return provider.listRecentChatSummaries(limit, maxAgeDays);
  }

  /**
   * Get a single chat's metadata
   */
  async getChat(chatId: string): Promise<ChatMetadata | null> {
    const provider = this.ensureInitialized();

    // LocalStorageProvider has getChat, others don't
    if ("getChat" in provider && typeof provider.getChat === "function") {
      return await (provider as any).getChat(chatId);
    }

    // Fallback: list all and find
    const chats = await provider.listChats();
    return chats.find((chat) => chat.id === chatId) || null;
  }

  /**
   * Get chat statistics (message count, token count, etc.)
   */
  async getChatStats(chatId: string): Promise<{
    message_count: number;
    token_count: number;
    cost_total: number;
    has_summary: boolean;
  }> {
    const provider = this.ensureInitialized();
    return await provider.getChatStats(chatId);
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
    const provider = this.ensureInitialized();
    return await provider.getGlobalCostStats();
  }

  async getChatCost(chatId: string): Promise<{
    total: number;
    byModel: Record<string, number>;
    messageCount: number;
    avgCostPerMessage: number;
  }> {
    const provider = this.ensureInitialized();
    return await provider.getChatCost(chatId);
  }

  async getDailyCostTrends(
    days?: number,
  ): Promise<
    Array<{ date: string; cost: number; messages: number; tokens: number }>
  > {
    const provider = this.ensureInitialized();
    return await provider.getDailyCostTrends(days);
  }

  async getModelDistribution(): Promise<
    Array<{ model: string; percentage: number; cost: number; messages: number }>
  > {
    const provider = this.ensureInitialized();
    return await provider.getModelDistribution();
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
    const provider = this.ensureInitialized();
    return await provider.getAgentStats(agentId);
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
    const provider = this.ensureInitialized();
    return await provider.getAllAgentStats();
  }

  async getAgentOutputs(agentId?: string): Promise<{
    documents: Array<{ id: string; title: string; createdAt: string }>;
    apps: Array<{ id: string; title: string; createdAt: string }>;
    plans: Array<{ planId: string; title: string; createdAt: string }>;
  }> {
    const provider = this.ensureInitialized();
    return await provider.getAgentOutputs(agentId);
  }

  getContextEfficiencyStats() {
    const provider = this.ensureInitialized();
    return provider.getContextEfficiencyStats();
  }

  getToolUsageByAgent(): Record<
    string,
    {
      mostUsedTools: Array<{ tool: string; count: number }>;
      totalToolInvocations: number;
    }
  > {
    const provider = this.ensureInitialized();
    return provider.getToolUsageByAgent();
  }

  // ===== Summary Operations =====

  /**
   * Fetch summary from PAPR or generate locally, then cache
   */
  async fetchAndCacheSummary(chatId: string): Promise<StoredSummary | null> {
    const provider = this.ensureInitialized();
    return await provider.fetchAndCacheSummary(chatId);
  }

  /**
   * Get cached summary
   */
  async getSummary(chatId: string): Promise<StoredSummary | null> {
    const provider = this.ensureInitialized();
    return await provider.getSummary(chatId);
  }

  /**
   * Save summary to local cache
   */
  async saveSummary(chatId: string, summary: StoredSummary): Promise<void> {
    const provider = this.ensureInitialized();
    await provider.saveSummary(chatId, summary);
  }

  // ===== Sync Operations (for Hybrid mode) =====

  /**
   * Mark a message as successfully synced to PAPR
   */
  async markMessageSynced(
    messageId: string,
    paprObjectId: string,
  ): Promise<void> {
    const provider = this.ensureInitialized();

    if ("markMessageSynced" in provider) {
      await (provider as any).markMessageSynced(messageId, paprObjectId);
    }
  }

  /**
   * Mark a message sync as failed
   */
  async markSyncFailed(messageId: string, error: string): Promise<void> {
    const provider = this.ensureInitialized();

    if ("markSyncFailed" in provider) {
      await (provider as any).markSyncFailed(messageId, error);
    }
  }

  /**
   * Get messages that need to be synced to PAPR
   */
  async getUnsyncedMessages(chatId: string): Promise<StoredMessage[]> {
    const provider = this.ensureInitialized();

    if ("getUnsyncedMessages" in provider) {
      return await (provider as any).getUnsyncedMessages(chatId);
    }

    return [];
  }

  async getChatSyncStats(chatId: string): Promise<{
    total: number;
    synced: number;
    sync_pending: number;
    sync_failed: number;
    local: number;
    papr_only: number;
    recentFailures: Array<{
      messageId: string;
      error: string;
      timestamp: string;
    }>;
  }> {
    const provider = this.ensureInitialized();

    if ("getChatSyncStats" in provider) {
      return await (
        provider as {
          getChatSyncStats: (
            id: string,
          ) => Promise<ReturnType<StorageManager["getChatSyncStats"]>>;
        }
      ).getChatSyncStats(chatId);
    }

    return {
      total: 0,
      synced: 0,
      sync_pending: 0,
      sync_failed: 0,
      local: 0,
      papr_only: 0,
      recentFailures: [],
    };
  }

  // ===== Configuration =====

  /**
   * Get current storage mode
   */
  getMode(): StorageMode | null {
    return this.currentMode;
  }

  /**
   * Get current configuration
   */
  getConfig(): StorageConfig | null {
    return this.config;
  }

  /**
   * Check if storage is initialized
   */
  isInitialized(): boolean {
    return this.provider !== null;
  }

  /**
   * Switch storage mode (requires re-initialization)
   */
  async switchMode(newConfig: StorageConfig): Promise<void> {
    console.log(
      `Switching storage mode from ${this.currentMode} to ${newConfig.mode}`,
    );
    await this.initialize(newConfig);
  }
}

// Singleton instance
let storageManagerInstance: StorageManager | null = null;

/**
 * Get the global StorageManager instance
 */
export function getStorageManager(): StorageManager {
  if (!storageManagerInstance) {
    storageManagerInstance = new StorageManager();
  }
  return storageManagerInstance;
}
