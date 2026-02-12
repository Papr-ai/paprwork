/**
 * Session manager - Handles chat sessions, history, and compaction
 * Keeps context window under control with smart compaction
 */

import { ChatStorage } from "../storage/ChatStorage.js";
import type {
  CoreMessage,
  PersistedMessage,
  CompactionEntry,
  CompactionConfig,
  StorageEntry,
} from "../types/index.js";

const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  maxTokens: 100000,
  targetTokens: 50000,
  minMessagesToKeep: 10,
  compactionPrompt:
    "Summarize the conversation history above concisely, preserving key context and decisions.",
};

export class SessionManager {
  private storage: ChatStorage;
  private config: CompactionConfig;

  constructor(userDataPath: string, config?: Partial<CompactionConfig>) {
    this.storage = new ChatStorage(userDataPath);
    this.config = { ...DEFAULT_COMPACTION_CONFIG, ...config };
  }

  /**
   * Initialize storage (creates directories)
   */
  async initialize(): Promise<void> {
    await this.storage.initialize();
  }

  /**
   * Load session messages as CoreMessage array for Mastra
   */
  async loadSession(chatId: string): Promise<CoreMessage[]> {
    const messages = await this.storage.loadMessages(chatId);

    return messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
  }

  /**
   * Save a message to the session
   */
  async saveMessage(chatId: string, message: CoreMessage): Promise<void> {
    await this.storage.saveMessage(chatId, message);
  }

  /**
   * Check if compaction is needed and perform it
   */
  async maybeCompact(
    chatId: string,
    messages: CoreMessage[],
  ): Promise<boolean> {
    const tokenCount = this.estimateTokens(messages);

    if (tokenCount <= this.config.maxTokens) {
      return false;
    }

    await this.compact(chatId, messages);
    return true;
  }

  /**
   * Perform compaction on chat history
   */
  private async compact(
    chatId: string,
    messages: CoreMessage[],
  ): Promise<void> {
    const messagesWithIds = await this.storage.loadMessages(chatId);

    if (messagesWithIds.length <= this.config.minMessagesToKeep) {
      // Not enough messages to compact
      return;
    }

    // Keep last N messages
    const messagesToKeep = messagesWithIds.slice(
      -this.config.minMessagesToKeep,
    );

    // Compact the rest
    const messagesToCompact = messagesWithIds.slice(
      0,
      -this.config.minMessagesToKeep,
    );

    if (messagesToCompact.length === 0) {
      return;
    }

    // Generate summary (simplified - in production, use LLM)
    const summary = this.generateSummary(messagesToCompact);

    const tokensBeforeCompaction = this.estimateTokens(messages);
    const tokensAfterCompaction = this.estimateTokens(
      messagesToKeep.map((m) => ({ role: m.role, content: m.content })),
    );

    const compactionEntry: CompactionEntry = {
      type: "compaction",
      summary,
      compactedCount: messagesToCompact.length,
      firstKeptEntryId: messagesToKeep[0]?.id || null,
      timestamp: new Date().toISOString(),
      tokensBeforeCompaction,
      tokensAfterCompaction,
    };

    // Rewrite chat file with compaction + kept messages
    const newEntries: StorageEntry[] = [compactionEntry, ...messagesToKeep];
    await this.storage.rewriteChat(chatId, newEntries);
  }

  /**
   * Generate summary of messages (simplified version)
   * In production, this should call an LLM for better summaries
   */
  private generateSummary(messages: PersistedMessage[]): string {
    const userMessages = messages.filter((m) => m.role === "user");
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    return `Compacted ${messages.length} messages (${userMessages.length} user, ${assistantMessages.length} assistant). Previous conversation context preserved.`;
  }

  /**
   * Estimate token count (rough approximation)
   * 1 token ≈ 4 characters for English text
   */
  private estimateTokens(messages: CoreMessage[]): number {
    const totalChars = messages.reduce(
      (sum, msg) => sum + msg.content.length,
      0,
    );
    return Math.ceil(totalChars / 4);
  }

  /**
   * Delete a chat session
   */
  async deleteSession(chatId: string): Promise<void> {
    await this.storage.deleteChat(chatId);
  }

  /**
   * List all chat sessions
   */
  async listSessions(): Promise<string[]> {
    return await this.storage.listChats();
  }

  /**
   * Get storage instance (for testing)
   */
  getStorage(): ChatStorage {
    return this.storage;
  }
}
