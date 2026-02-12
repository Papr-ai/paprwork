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
} from './IStorageProvider';
import { LocalStorageProvider } from './LocalStorageProvider.js';
import { PaprMemoryProvider, type PaprConfig } from './PaprMemoryProvider.js';

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

  // ===== Message Operations =====

  async saveMessage(chatId: string, message: StoredMessage): Promise<void> {
    // 1. ALWAYS save locally first (fast, reliable)
    await this.local.saveMessage(chatId, {
      ...message,
      sync_status: 'sync_pending'
    });

    // 2. Sync to PAPR in background (non-blocking)
    if (this.syncEnabled) {
      this.syncMessageToPapr(chatId, message).catch(err => {
        console.error(`Failed to sync message ${message.id} to PAPR:`, err);
        this.local.markSyncFailed(message.id, err.message);
      });
    }
  }

  private async syncMessageToPapr(chatId: string, message: StoredMessage): Promise<void> {
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

  async loadMessages(chatId: string, limit?: number, skip?: number): Promise<StoredMessage[]> {
    // Try PAPR first if synced
    if (this.syncEnabled) {
      try {
        const paprMessages = await this.papr.loadMessages(chatId, limit, skip);
        if (paprMessages.length > 0) {
          return paprMessages;
        }
      } catch (error) {
        console.warn('Failed to load from PAPR, using local:', error);
      }
    }

    // Fallback to local
    return this.local.loadMessages(chatId, limit, skip);
  }

  async loadMessagesForLLM(chatId: string): Promise<any[]> {
    // Prefer PAPR if synced (has better summaries)
    if (this.syncEnabled) {
      try {
        const paprMessages = await this.papr.loadMessagesForLLM(chatId);
        if (paprMessages.length > 0) {
          return paprMessages;
        }
      } catch (error) {
        console.warn('Failed to load from PAPR, using local:', error);
      }
    }

    // Fallback to local
    return this.local.loadMessagesForLLM(chatId);
  }

  // ===== Summary Operations =====

  async fetchAndCacheSummary(chatId: string): Promise<StoredSummary | null> {
    if (!this.syncEnabled) {
      // Sync disabled, use local only
      return this.local.fetchAndCacheSummary(chatId);
    }

    try {
      // 1. Fetch from PAPR compress endpoint
      const summary = await this.papr.fetchAndCacheSummary(chatId);

      if (summary) {
        // 2. Cache in local SQLite for offline access
        await this.local.saveSummary(chatId, summary);
        return summary;
      }

      return null;
    } catch (error) {
      console.error('PAPR compress failed, using local fallback:', error);

      // 3. Fallback to local LLM generation (if implemented)
      return this.local.fetchAndCacheSummary(chatId);
    }
  }

  async getSummary(chatId: string): Promise<StoredSummary | null> {
    // Check local cache first
    const cached = await this.local.getSummary(chatId);

    if (cached) {
      // Check if cache is fresh (< 1 hour old)
      const cacheAge = cached.last_fetched_at
        ? Date.now() - new Date(cached.last_fetched_at).getTime()
        : Infinity;

      if (cacheAge < 60 * 60 * 1000) { // 1 hour
        return cached;
      }
    }

    // Cache stale or missing, fetch fresh
    return this.fetchAndCacheSummary(chatId);
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

  async updateChat(chatId: string, updates: Partial<{ title: string }>): Promise<void> {
    // Update locally
    await this.local.updateChat(chatId, updates);

    // Sync to PAPR if enabled
    if (this.syncEnabled && updates.title) {
      try {
        await this.papr.updateChat(chatId, updates);
      } catch (error) {
        console.error('Failed to sync chat update to PAPR:', error);
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

  // ===== Sync Operations =====

  async markMessageSynced(messageId: string, paprObjectId: string): Promise<void> {
    await this.local.markMessageSynced(messageId, paprObjectId);
  }

  async markSyncFailed(messageId: string, error: string): Promise<void> {
    await this.local.markSyncFailed(messageId, error);
  }

  async getUnsyncedMessages(chatId: string): Promise<StoredMessage[]> {
    return this.local.getUnsyncedMessages(chatId);
  }

  async getChatStats(chatId: string): Promise<{
    message_count: number;
    token_count: number;
    has_summary: boolean;
  }> {
    // Use local stats (faster)
    return this.local.getChatStats(chatId);
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
