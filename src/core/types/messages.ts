/**
 * Core message types for chat history
 */

export type MessageRole = "user" | "assistant";

/**
 * Core message format used by Mastra
 */
export interface CoreMessage {
  role: MessageRole;
  content: string;
}

/**
 * Persisted message with metadata
 */
export interface PersistedMessage extends CoreMessage {
  id: string;
  timestamp: string;
}

/**
 * Compaction entry for context window management
 */
export interface CompactionEntry {
  type: "compaction";
  summary: string;
  compactedCount: number;
  firstKeptEntryId: string | null;
  timestamp: string;
  tokensBeforeCompaction: number;
  tokensAfterCompaction: number;
}

/**
 * Chat session metadata
 */
export interface ChatMetadata {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  provider: string;
  model: string;
}
