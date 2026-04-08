/**
 * Chat Types - Shared type definitions for chat functionality
 */

import type { CoreMessage } from "./core";

export interface ChatMetadata {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  isStreaming?: boolean; // Track if this chat is actively streaming
  hasUnread?: boolean; // Track if chat has unread messages
}

export interface ChatMessage extends CoreMessage {
  id: string;
  isStreaming?: boolean;
  streamingContent?: string;
  elapsedSeconds?: number; // Server-provided elapsed work time

  // V1-style sequence for interleaving text and tool calls
  sequence?: Array<{
    type: "text" | "tool" | "thinking";
    data: string | Record<string, any>;
  }>;
}

export interface ChatState {
  messages: ChatMessage[];
  isLoading: boolean;
  isSending: boolean;
  isStreaming: boolean;
  hasUnread: boolean;
  draftMessage?: string; // Persisted draft message for this chat
  lastSelectedModelId?: string; // Last model user chose for this chat
}

export interface CreateChatPayload {
  title?: string;
  initialMessage?: string;
}

export interface UpdateChatPayload {
  chatId: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface DeleteChatPayload {
  chatId: string;
}
