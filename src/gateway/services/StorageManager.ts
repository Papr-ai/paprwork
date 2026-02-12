/**
 * Storage Manager
 * 
 * Manages storage provider initialization and provides unified interface
 * for chat persistence. Handles switching between Local/PAPR/Hybrid modes.
 */

import type { IStorageProvider, StoredMessage, StoredSummary, ChatMetadata } from './storage/IStorageProvider.js';
import { LocalStorageProvider } from './storage/LocalStorageProvider.js';
import { PaprMemoryProvider } from './storage/PaprMemoryProvider.js';
import { HybridStorageProvider } from './storage/HybridStorageProvider.js';
import * as path from 'path';
import * as os from 'os';

export type StorageMode = 'local' | 'papr' | 'hybrid';

export interface StorageConfig {
  mode: StorageMode;
  
  // Local storage config
  userDataPath?: string;  // Path for SQLite database
  
  // PAPR config
  paprApiKey?: string;
  paprBaseUrl?: string;
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

    // Create appropriate provider based on mode
    switch (config.mode) {
      case 'local':
        this.provider = new LocalStorageProvider(
          config.userDataPath || this.getDefaultUserDataPath()
        );
        break;

      case 'papr':
        if (!config.paprApiKey) {
          throw new Error('PAPR API key required for PAPR mode');
        }
        this.provider = new PaprMemoryProvider({
          apiKey: config.paprApiKey,
          baseUrl: config.paprBaseUrl,
        });
        break;

      case 'hybrid':
        if (!config.paprApiKey) {
          throw new Error('PAPR API key required for Hybrid mode');
        }
        this.provider = new HybridStorageProvider(
          config.userDataPath || this.getDefaultUserDataPath(),
          {
            apiKey: config.paprApiKey,
            baseUrl: config.paprBaseUrl,
          }
        );
        break;

      default:
        throw new Error(`Unknown storage mode: ${config.mode}`);
    }

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
    return path.join(os.homedir(), '.paprwork-v2');
  }

  /**
   * Ensure provider is initialized
   */
  private ensureInitialized(): IStorageProvider {
    if (!this.provider) {
      throw new Error('StorageManager not initialized. Call initialize() first.');
    }
    return this.provider;
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
   * Load all messages for a chat
   */
  async loadMessages(chatId: string, limit?: number, skip?: number): Promise<StoredMessage[]> {
    const provider = this.ensureInitialized();
    return await provider.loadMessages(chatId, limit, skip);
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
  async updateChat(chatId: string, updates: Partial<{ title: string }>): Promise<void> {
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

  /**
   * Get a single chat's metadata
   */
  async getChat(chatId: string): Promise<ChatMetadata | null> {
    const provider = this.ensureInitialized();
    
    // LocalStorageProvider has getChat, others don't
    if ('getChat' in provider && typeof provider.getChat === 'function') {
      return await (provider as any).getChat(chatId);
    }
    
    // Fallback: list all and find
    const chats = await provider.listChats();
    return chats.find(chat => chat.id === chatId) || null;
  }

  /**
   * Get chat statistics (message count, token count, etc.)
   */
  async getChatStats(chatId: string): Promise<{
    message_count: number;
    token_count: number;
    has_summary: boolean;
  }> {
    const provider = this.ensureInitialized();
    return await provider.getChatStats(chatId);
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
  async markMessageSynced(messageId: string, paprObjectId: string): Promise<void> {
    const provider = this.ensureInitialized();
    
    if ('markMessageSynced' in provider) {
      await (provider as any).markMessageSynced(messageId, paprObjectId);
    }
  }

  /**
   * Mark a message sync as failed
   */
  async markSyncFailed(messageId: string, error: string): Promise<void> {
    const provider = this.ensureInitialized();
    
    if ('markSyncFailed' in provider) {
      await (provider as any).markSyncFailed(messageId, error);
    }
  }

  /**
   * Get messages that need to be synced to PAPR
   */
  async getUnsyncedMessages(chatId: string): Promise<StoredMessage[]> {
    const provider = this.ensureInitialized();
    
    if ('getUnsyncedMessages' in provider) {
      return await (provider as any).getUnsyncedMessages(chatId);
    }
    
    return [];
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
    console.log(`Switching storage mode from ${this.currentMode} to ${newConfig.mode}`);
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
