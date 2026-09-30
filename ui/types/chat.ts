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
  /** Who can read derived memories from this chat */
  memoryScope?: "user" | "namespace" | "org";
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

/** File/context attached to a user message (shown in chat history). */
export interface MessageAttachment {
  id: string;
  name: string;
  kind: "file" | "document" | "app";
  mimeType?: string;
  filePath?: string;
}

export interface ChatMessage extends CoreMessage {
  id: string;
  isStreaming?: boolean;
  /**
   * The turn ended without the agent finishing — gateway crash, restart, or an
   * abandoned stream. Set when finalizing a partial message so the UI reports it
   * as interrupted instead of presenting the truncated work as a finished answer.
   */
  interrupted?: boolean;
  streamingContent?: string;
  /** Context files/docs attached when the user sent this message */
  attachments?: MessageAttachment[];
  /**
   * Model that produced this assistant message, as persisted by the gateway.
   * Read back to restore a chat's own model on reopen.
   */
  model?: string;

  /** Assistant summary after a sub-agent delegation finished (SubAgentResponseTrigger) */
  delegationFinishFor?: string;

  // V1-style sequence for interleaving text and tool calls
  sequence?: SequenceItem[];
}

/**
 * Why the turn stopped and is offering Resume. The banner copy differs: a dropped
 * gateway is our problem to explain, a provider rate limit is the user's to wait out.
 */
export type StreamRecoveryReason = "connection" | "rateLimit";

/**
 * Why the last turn ended, when it ended in a way auto-continue must respect.
 * Absent means nothing blocks a retry.
 *
 * This cannot be read off `needsStreamRecovery`, for two reasons that pull in
 * opposite directions. A spent quota deliberately offers no Resume (Issue 77),
 * so the banner state never carries it. And `interruptActiveStream` clears the
 * banner — so a Stop pressed on a refused turn would erase the evidence of the
 * refusal at exactly the moment the user asked us to stop retrying.
 */
export type LastTurnOutcome = "providerRefused" | "userStopped";

export interface ChatState {
  messages: ChatMessage[];
  isLoading: boolean;
  isSending: boolean;
  isStreaming: boolean;
  /** True when gateway disconnected mid-stream — Working card shows reconnecting */
  connectionPaused?: boolean;
  /** Waiting for a chat-pool agent slot — no model work has started yet */
  isWaitingForAgentSlot?: boolean;
  /** Post-tool text summary in progress (wrap-up continuation). */
  isFinishingWork?: boolean;
  /** Auto-resume failed — user can tap Continue to retry stream recovery */
  needsStreamRecovery?: boolean;
  /** Defaults to "connection" when unset, matching the original recovery banner. */
  streamRecoveryReason?: StreamRecoveryReason;
  /**
   * What the provider actually said, when it said something specific. The
   * banner used to be a fixed sentence and the composed explanation — which
   * credential was refused, and why — was dropped on the floor.
   */
  streamRecoveryDetail?: string;
  /**
   * Set when the provider refused the turn or the user stopped it. Cleared only
   * by a deliberate new attempt (sending a message, or tapping Resume), so a
   * retry is never something the app decided on the user's behalf.
   */
  lastTurnOutcome?: LastTurnOutcome;
  hasUnread: boolean;
  draftMessage?: string; // Persisted draft message for this chat
  lastSelectedModelId?: string; // Last model user chose for this chat
  hasMoreMessages?: boolean; // Whether there are older messages to load
  isLoadingMore?: boolean; // Whether currently loading older messages
  /**
   * The last history load threw rather than returning a (possibly empty) list.
   *
   * A failed load leaves `messages` empty, which is the same shape as a chat
   * that genuinely has none — so without this the pane renders the "What would
   * you like to build?" welcome screen over a conversation that is sitting
   * intact in SQLite. Not persisted: it records an attempt we watched fail, so
   * after a reload we hold no evidence and should not claim any.
   */
  historyLoadFailed?: boolean;
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
