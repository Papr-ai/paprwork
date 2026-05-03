/**
 * Chat Types - Shared type definitions for chat functionality
 */

import type { CoreMessage, ToolCall } from "./core";

export interface ChatMetadata {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  isStreaming?: boolean; // Track if this chat is actively streaming
  hasUnread?: boolean; // Track if chat has unread messages
}

/**
 * A single item in a message's interleaved sequence of text + tools + thinking.
 * Used by both persisted messages (ChatMessage.sequence) and the live streaming
 * slice (StreamingState.sequence).
 */
export interface SequenceItem {
  type: "text" | "tool" | "thinking";
  data: string | Record<string, any>;
}

export interface ChatMessage extends CoreMessage {
  id: string;
  isStreaming?: boolean;
  streamingContent?: string;

  // V1-style sequence for interleaving text and tool calls
  sequence?: SequenceItem[];
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

/**
 * Ephemeral live-streaming state for an in-flight assistant message.
 *
 * SEPARATED from ChatState.messages on purpose: the streaming hot path
 * (text-delta ~2800/turn, tool-call/tool-result ~50-100/turn) would otherwise
 * force MessageList + every MessageItem to re-render on every chunk, because
 * `messages` is replaced with a new array reference.
 *
 * Lifecycle:
 *   - Stream start: initStreamingState(chatId, messageId)
 *   - text-delta:   appendStreamingText(chatId, delta) [throttled to 50ms]
 *   - reasoning:    appendStreamingReasoning(chatId, delta) [throttled to 50ms]
 *   - tool-call:    upsertStreamingToolCall(chatId, toolCall) [coalesced via rAF]
 *   - tool-result:  upsertStreamingToolCall(chatId, toolCall) [coalesced via rAF]
 *   - done / stop:  flushStreamingState(chatId) -> writes into messages[], clears slice
 *
 * Subscribers MUST use selectors keyed on chatId so unrelated chats don't re-render.
 */
export interface StreamingState {
  /** ID of the placeholder message being populated (links to chatStates.messages) */
  messageId: string;
  /** Live streaming text segment (mutates ~2800x per turn for big responses) */
  text: string;
  /** Live streaming reasoning/thinking text (mutates ~variable per turn) */
  reasoning: string;
  /** Interleaved sequence built up as text/tool events arrive */
  sequence: SequenceItem[];
  /** Tool calls keyed by toolCallId - granular subscriptions per row */
  toolCalls: Map<string, ToolCall>;
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
