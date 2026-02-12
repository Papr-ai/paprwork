/**
 * Storage Provider Interface
 * 
 * Abstraction layer for different storage modes:
 * - LocalStorageProvider: SQLite only (offline mode)
 * - PaprMemoryProvider: PAPR API only (cloud mode)
 * - HybridStorageProvider: Local cache + PAPR sync
 */

export interface StoredMessage {
  id: string;
  chat_id: string;
  role: 'user' | 'assistant';  // Aligned with CoreMessage
  content: string;              // Aligned with CoreMessage
  timestamp: string;
  
  // AI response metadata
  thinking?: string;            // Reasoning/thinking from model
  toolCalls?: Array<{           // Tool calls made during response
    id: string;
    name: string;
    args: Record<string, any>;
    result?: string;
    status?: 'pending' | 'success' | 'error';
  }>;
  
  // Model metadata
  model?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  
  // Error tracking
  error?: string;               // Error message if response failed
  incomplete?: boolean;         // True if response was interrupted
  
  // Sync tracking
  sync_status: 'local' | 'synced' | 'sync_pending' | 'sync_failed';
  papr_message_id?: string;  // Parse PostMessage objectId
  last_sync_attempt?: string;
  sync_error?: string;
}

export interface StoredSummary {
  short_term: string;         // Last 15 messages
  medium_term: string;        // Last ~100 messages
  long_term: string;          // Full session summary
  topics: string[];
  last_updated: string;
  
  // Source tracking
  fetched_from_papr: boolean;
  last_fetched_at?: string;
}

export interface ChatMetadata {
  id: string;
  title: string;
  message_count: number;
  created_at: string;
  updated_at: string;
  last_synced_at?: string;
}

export interface IStorageProvider {
  /**
   * Initialize storage (create directories, databases, etc.)
   */
  initialize(): Promise<void>;
  
  // ===== Message Operations =====
  
  /**
   * Save a message
   * @param chatId - Chat session ID
   * @param message - Message to save
   */
  saveMessage(chatId: string, message: StoredMessage): Promise<void>;
  
  /**
   * Load all messages for a chat
   * @param chatId - Chat session ID
   * @param limit - Optional limit
   * @param skip - Optional skip for pagination
   */
  loadMessages(chatId: string, limit?: number, skip?: number): Promise<StoredMessage[]>;
  
  /**
   * Load messages formatted for LLM consumption
   * Returns summary + recent messages when appropriate
   * @param chatId - Chat session ID
   */
  loadMessagesForLLM(chatId: string): Promise<any[]>;
  
  // ===== Summary Operations =====
  
  /**
   * Fetch summary and cache it locally
   * - For PAPR modes: GET /compress endpoint
   * - For local mode: Generate with LLM
   * @param chatId - Chat session ID
   */
  fetchAndCacheSummary(chatId: string): Promise<StoredSummary | null>;
  
  /**
   * Get cached summary
   * @param chatId - Chat session ID
   */
  getSummary(chatId: string): Promise<StoredSummary | null>;
  
  /**
   * Save summary to local cache
   * @param chatId - Chat session ID
   * @param summary - Summary to save
   */
  saveSummary(chatId: string, summary: StoredSummary): Promise<void>;
  
  // ===== Chat Operations =====
  
  /**
   * Create a new chat session
   * @param chatId - Chat session ID
   * @param title - Optional title
   */
  createChat(chatId: string, title?: string): Promise<void>;
  
  /**
   * Update chat metadata
   * @param chatId - Chat session ID
   * @param updates - Fields to update
   */
  updateChat(chatId: string, updates: Partial<{ title: string }>): Promise<void>;
  
  /**
   * Delete a chat and all its messages
   * @param chatId - Chat session ID
   */
  deleteChat(chatId: string): Promise<void>;
  
  /**
   * List all chats
   */
  listChats(): Promise<ChatMetadata[]>;
  
  // ===== Sync Operations =====
  
  /**
   * Mark a message as synced to PAPR
   * @param messageId - Local message ID
   * @param paprObjectId - Parse objectId from PAPR
   */
  markMessageSynced(messageId: string, paprObjectId: string): Promise<void>;
  
  /**
   * Mark a message sync as failed
   * @param messageId - Local message ID
   * @param error - Error message
   */
  markSyncFailed(messageId: string, error: string): Promise<void>;
  
  /**
   * Get unsynced messages for a chat
   * @param chatId - Chat session ID
   */
  getUnsyncedMessages(chatId: string): Promise<StoredMessage[]>;
  
  /**
   * Get chat statistics (token count, message count, etc.)
   * @param chatId - Chat session ID
   */
  getChatStats(chatId: string): Promise<{
    message_count: number;
    token_count: number;
    has_summary: boolean;
  }>;
}
