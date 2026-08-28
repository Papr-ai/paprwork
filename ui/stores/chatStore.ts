/**
 * Chat Store - Global state management for chat UI
 * Uses Zustand for simple, performant state management
 * Supports parallel chat streaming with per-chat state
 */

import { create } from "zustand";
import type {
  ChatMetadata,
  ChatMessage,
  ChatState,
  StreamingState,
  SequenceItem,
  StreamRecoveryReason,
} from "../types/chat";
import type { MemoryAudience } from "../constants/memoryScope";
import type { ToolCall } from "../types/core";
import { gateway } from "../src/lib/gateway";
import { trackEvent } from "../lib/telemetry";

// Re-export types for backward compatibility
export type { ChatMetadata, ChatMessage, ChatState, StreamingState, SequenceItem, MessageAttachment };

interface ChatStore {
  // All chat metadata
  chats: ChatMetadata[];

  /** Client-side memory scope per chat (includes temp ids before server persist). */
  memoryScopeByChatId: Map<string, MemoryAudience>;

  // Per-chat state for parallel streaming (keyed by chatId)
  chatStates: Map<string, ChatState>;

  // UI state (global - only for non-chat-specific loading/errors)
  isLoading: boolean;
  error: string | null;

  // Actions
  addMessage: (message: ChatMessage, chatId?: string) => void;
  prependMessages: (messages: ChatMessage[], chatId: string) => void;
  /** Clear cached chats/messages after org/namespace workspace switch. */
  resetForWorkspaceSwitch: () => void;
  updateStreamingMessage: (
    messageId: string,
    content: string,
    chatId?: string,
  ) => void;
  finalizeStreamingMessage: (messageId: string, chatId?: string) => void;
  /** Move chat state from a temp id to a permanent id (first message in new chat). */
  migrateChatId: (oldChatId: string, newChatId: string) => void;
  setChats: (chats: ChatMetadata[]) => void;
  setChatMemoryScope: (chatId: string, scope: MemoryAudience) => void;
  getChatMemoryScope: (chatId: string) => MemoryAudience;
  setLoading: (loading: boolean) => void;
  setSending: (chatId: string, sending: boolean) => void;
  setConnectionPaused: (chatId: string, paused: boolean) => void;
  setFinishingWork: (chatId: string, finishing: boolean) => void;
  setNeedsStreamRecovery: (
    chatId: string,
    needs: boolean,
    reason?: StreamRecoveryReason,
  ) => void;
  setError: (error: string | null) => void;

  // Parallel chat state management
  setChatStreaming: (chatId: string, isStreaming: boolean) => void;
  setChatUnread: (chatId: string, hasUnread: boolean) => void;
  markChatAsRead: (chatId: string) => void;
  getChatState: (chatId: string) => ChatState;

  // Pagination management
  setHasMoreMessages: (chatId: string, hasMore: boolean) => void;
  setLoadingMore: (chatId: string, isLoading: boolean) => void;

  // Draft message management
  setDraftMessage: (chatId: string, draft: string) => void;
  getDraftMessage: (chatId: string) => string;
  clearDraftMessage: (chatId: string) => void;

  // Model selection per chat
  setLastSelectedModel: (chatId: string, modelId: string) => void;
  getLastSelectedModel: (chatId: string) => string | undefined;

  // ──────────────────────────────────────────────────────────────────────
  // Live streaming slice (ephemeral, separate from chatStates.messages)
  // See StreamingState type docs for lifecycle.
  // ──────────────────────────────────────────────────────────────────────
  streamingState: Map<string, StreamingState>;

  /** Initialise streaming slice for a new in-flight assistant message. */
  initStreamingState: (chatId: string, messageId: string) => void;
  /** Append a text delta. Caller is responsible for throttling. */
  appendStreamingText: (chatId: string, delta: string) => void;
  /** Replace streaming text wholesale (when caller already accumulates in a ref). */
  setStreamingText: (chatId: string, text: string) => void;
  /** Append a reasoning delta. Caller is responsible for throttling. */
  appendStreamingReasoning: (chatId: string, delta: string) => void;
  /** Replace streaming reasoning wholesale. */
  setStreamingReasoning: (chatId: string, reasoning: string) => void;
  /** Replace the streaming sequence wholesale (used when sequence is rebuilt). */
  replaceStreamingSequence: (chatId: string, sequence: SequenceItem[]) => void;
  /** Insert/update a single tool call by id. Triggers granular row re-render. */
  upsertStreamingToolCall: (chatId: string, toolCall: ToolCall) => void;
  /**
   * Flush streaming slice into the placeholder message in chatStates.messages
   * and clear the slice. Called on stream done / abort.
   * If overrides are provided (e.g. backend-provided final sequence), they win.
   */
  flushStreamingState: (
    chatId: string,
    overrides?: {
      content?: string;
      reasoning?: string;
      sequence?: SequenceItem[];
      toolCalls?: ToolCall[];
      isStreaming?: boolean;
    },
  ) => void;
  /** Drop streaming slice without flushing (errors, hard abort). */
  clearStreamingState: (chatId: string) => void;
  /** Read the current streaming slice for a chat (no subscription). */
  getStreamingState: (chatId: string) => StreamingState | undefined;
}

export const defaultChatState: ChatState = {
  messages: [],
  isLoading: false,
  isSending: false,
  isStreaming: false,
  hasUnread: false,
  hasMoreMessages: true, // Assume there might be more until we know otherwise
  isLoadingMore: false,
};

export const useChatStore = create<ChatStore>((set, get) => ({
  // Initial state
  chats: [],
  memoryScopeByChatId: new Map(),
  chatStates: new Map(),
  streamingState: new Map(),
  isLoading: false,
  error: null,

  // Actions

  addMessage: (message, chatId) =>
    set((state) => {
      if (!chatId) {
        console.warn("[chatStore] addMessage called without chatId");
        return state;
      }

      // Update messages for target chat
      const chatState = state.chatStates.get(chatId) || {
        ...defaultChatState,
      };
      
      // Check if message already exists (prevent duplicates)
      const messageExists = chatState.messages.some(m => m.id === message.id);
      if (messageExists) {
        console.warn(`[chatStore] Message ${message.id} already exists in chat ${chatId}, skipping add`);
        return state;
      }
      
      const updatedMessages = [...chatState.messages, message];

      // Update chat state map
      const newChatStates = new Map(state.chatStates);
      newChatStates.set(chatId, {
        ...chatState,
        messages: updatedMessages,
      });

      return {
        chatStates: newChatStates,
      };
    }),

  prependMessages: (messages, chatId) =>
    set((state) => {
      const chatState = state.chatStates.get(chatId) || {
        ...defaultChatState,
      };
      
      // Deduplicate: only prepend messages that don't already exist
      const existingIds = new Set(chatState.messages.map(m => m.id));
      const newMessages = messages.filter(m => !existingIds.has(m.id));
      const updatedMessages = [...newMessages, ...chatState.messages];

      const newChatStates = new Map(state.chatStates);
      newChatStates.set(chatId, {
        ...chatState,
        messages: updatedMessages,
        isLoadingMore: false,
      });

      return {
        chatStates: newChatStates,
      };
    }),

  updateStreamingMessage: (messageId, content, chatId) =>
    set((state) => {
      if (!chatId) {
        console.warn(
          "[chatStore] updateStreamingMessage called without chatId",
        );
        return state;
      }

      const chatState = state.chatStates.get(chatId);
      if (!chatState) {
        console.warn(`[chatStore] No chat state found for chatId: ${chatId}`);
        return state;
      }

      // Find the message index for efficient update
      const messageIndex = chatState.messages.findIndex(
        (msg) => msg.id === messageId,
      );
      if (messageIndex === -1) {
        console.warn(
          `[chatStore] Message ${messageId} not found in chat ${chatId}`,
        );
        return state;
      }

      // Update only the specific message (more efficient than map)
      const updatedMessages = [...chatState.messages];
      updatedMessages[messageIndex] = {
        ...updatedMessages[messageIndex],
        content,
        isStreaming: true,
        streamingContent: content,
      };

      // Only create new Map if we're actually updating
      const newChatStates = new Map(state.chatStates);
      newChatStates.set(chatId, {
        ...chatState,
        messages: updatedMessages,
        isStreaming: true,
      });

      return {
        chatStates: newChatStates,
        // Skip updating chats array unless necessary
      };
    }),

  finalizeStreamingMessage: (messageId, chatId) =>
    set((state) => {
      if (!chatId) {
        console.warn(
          "[chatStore] finalizeStreamingMessage called without chatId",
        );
        return state;
      }

      const chatState = state.chatStates.get(chatId) || {
        ...defaultChatState,
      };
      const updatedMessages = chatState.messages.map((msg) =>
        msg.id === messageId
          ? {
              ...msg,
              content: msg.streamingContent || msg.content,
              reasoning: msg.streamingReasoning || msg.reasoning,
              isStreaming: false,
              streamingContent: undefined,
              streamingReasoning: undefined,
            }
          : msg,
      );

      const newChatStates = new Map(state.chatStates);
      newChatStates.set(chatId, {
        ...chatState,
        messages: updatedMessages,
        isStreaming: false,
      });

      return {
        chatStates: newChatStates,
        chats: state.chats.map((chat) =>
          chat.id === chatId ? { ...chat, isStreaming: false } : chat,
        ),
      };
    }),

  migrateChatId: (oldChatId, newChatId) =>
    set((state) => {
      if (oldChatId === newChatId) return state;

      const oldState = state.chatStates.get(oldChatId);
      const newChatStates = new Map(state.chatStates);
      const existingNew = newChatStates.get(newChatId);

      if (oldState) {
        newChatStates.set(newChatId, {
          ...(existingNew ?? defaultChatState),
          ...oldState,
          messages:
            existingNew && existingNew.messages.length > 0
              ? existingNew.messages
              : [...oldState.messages],
        });
        newChatStates.delete(oldChatId);
      }

      const newStreamingState = new Map(state.streamingState);
      const oldStreaming = state.streamingState.get(oldChatId);
      if (oldStreaming && !newStreamingState.has(newChatId)) {
        newStreamingState.set(newChatId, oldStreaming);
        newStreamingState.delete(oldChatId);
      }

      const memoryScopeByChatId = new Map(state.memoryScopeByChatId);
      const migratedScope = memoryScopeByChatId.get(oldChatId);
      if (migratedScope) {
        memoryScopeByChatId.set(newChatId, migratedScope);
        memoryScopeByChatId.delete(oldChatId);
      }

      const oldChatMeta = state.chats.find((chat) => chat.id === oldChatId);
      const chats = state.chats
        .filter((chat) => chat.id !== oldChatId)
        .map((chat) =>
          chat.id === newChatId && migratedScope
            ? { ...chat, memoryScope: migratedScope }
            : chat,
        );
      if (oldChatMeta && !chats.some((chat) => chat.id === newChatId)) {
        chats.unshift({
          ...oldChatMeta,
          id: newChatId,
          memoryScope: migratedScope ?? oldChatMeta.memoryScope,
        });
      }

      return {
        chatStates: newChatStates,
        streamingState: newStreamingState,
        memoryScopeByChatId,
        chats,
      };
    }),

  setChats: (incoming) =>
    set((state) => {
      const memoryScopeByChatId = new Map(state.memoryScopeByChatId);
      const chats = incoming.map((chat) => {
        const serverScope = chat.memoryScope ?? "user";
        const localScope = memoryScopeByChatId.get(chat.id);
        const resolvedScope =
          localScope && localScope !== "user" && serverScope === "user"
            ? localScope
            : serverScope;
        memoryScopeByChatId.set(chat.id, resolvedScope);
        return { ...chat, memoryScope: resolvedScope };
      });
      return { chats, memoryScopeByChatId };
    }),

  setChatMemoryScope: (chatId, scope) =>
    set((state) => {
      const memoryScopeByChatId = new Map(state.memoryScopeByChatId);
      memoryScopeByChatId.set(chatId, scope);
      return {
        memoryScopeByChatId,
        chats: state.chats.map((chat) =>
          chat.id === chatId ? { ...chat, memoryScope: scope } : chat,
        ),
      };
    }),

  getChatMemoryScope: (chatId) => {
    const state = get();
    const scoped = state.memoryScopeByChatId.get(chatId);
    if (scoped) {
      return scoped;
    }
    const chat = state.chats.find((item) => item.id === chatId);
    return chat?.memoryScope ?? "user";
  },

  resetForWorkspaceSwitch: () =>
    set({
      chats: [],
      memoryScopeByChatId: new Map(),
      chatStates: new Map(),
      streamingState: new Map(),
      isLoading: false,
      error: null,
    }),

  setLoading: (loading) => set({ isLoading: loading }),

  setSending: (chatId, sending) =>
    set((state) => {
      const chatState = state.chatStates.get(chatId) ?? {
        ...defaultChatState,
      };

      const newChatStates = new Map(state.chatStates);
      newChatStates.set(chatId, {
        ...chatState,
        isSending: sending,
      });

      return { chatStates: newChatStates };
    }),

  setConnectionPaused: (chatId, paused) =>
    set((state) => {
      const chatState = state.chatStates.get(chatId);
      if (!chatState) return state;

      const newChatStates = new Map(state.chatStates);
      newChatStates.set(chatId, {
        ...chatState,
        connectionPaused: paused,
        ...(paused ? {} : { needsStreamRecovery: false }),
      });

      return { chatStates: newChatStates };
    }),

  setFinishingWork: (chatId, finishing) =>
    set((state) => {
      const chatState = state.chatStates.get(chatId);
      if (!chatState) return state;

      const newChatStates = new Map(state.chatStates);
      newChatStates.set(chatId, {
        ...chatState,
        isFinishingWork: finishing,
      });

      return { chatStates: newChatStates };
    }),

  setNeedsStreamRecovery: (chatId, needs, reason = "connection") =>
    set((state) => {
      const chatState = state.chatStates.get(chatId);
      if (!chatState) return state;

      const newChatStates = new Map(state.chatStates);
      newChatStates.set(chatId, {
        ...chatState,
        needsStreamRecovery: needs,
        ...(needs
          ? { connectionPaused: false, streamRecoveryReason: reason }
          : { streamRecoveryReason: undefined }),
      });

      return { chatStates: newChatStates };
    }),

  setError: (error) => set({ error }),

  // Parallel chat state management
  setChatStreaming: (chatId, isStreaming) =>
    set((state) => {
      const chatState = state.chatStates.get(chatId) || { ...defaultChatState };
      const newChatStates = new Map(state.chatStates);
      newChatStates.set(chatId, { ...chatState, isStreaming });

      return {
        chatStates: newChatStates,
        chats: state.chats.map((chat) =>
          chat.id === chatId ? { ...chat, isStreaming } : chat,
        ),
      };
    }),

  setChatUnread: (chatId, hasUnread) =>
    set((state) => ({
      chats: state.chats.map((chat) =>
        chat.id === chatId ? { ...chat, hasUnread } : chat,
      ),
    })),

  markChatAsRead: (chatId) =>
    set((state) => ({
      chats: state.chats.map((chat) =>
        chat.id === chatId ? { ...chat, hasUnread: false } : chat,
      ),
    })),

  getChatState: (chatId) => {
    const state = get();
    return state.chatStates.get(chatId) || { ...defaultChatState };
  },

  // Pagination management
  setHasMoreMessages: (chatId, hasMore) =>
    set((state) => {
      const chatState = state.chatStates.get(chatId);
      if (!chatState) return state;

      const newChatStates = new Map(state.chatStates);
      newChatStates.set(chatId, { ...chatState, hasMoreMessages: hasMore });
      return { chatStates: newChatStates };
    }),

  setLoadingMore: (chatId, isLoading) =>
    set((state) => {
      const chatState = state.chatStates.get(chatId);
      if (!chatState) return state;

      const newChatStates = new Map(state.chatStates);
      newChatStates.set(chatId, { ...chatState, isLoadingMore: isLoading });
      return { chatStates: newChatStates };
    }),

  // Draft message management
  setDraftMessage: (chatId, draft) =>
    set((state) => {
      const chatState = state.chatStates.get(chatId) || { ...defaultChatState };
      const newChatStates = new Map(state.chatStates);
      newChatStates.set(chatId, { ...chatState, draftMessage: draft });
      return { chatStates: newChatStates };
    }),

  getDraftMessage: (chatId) => {
    const state = get();
    const chatState = state.chatStates.get(chatId);
    return chatState?.draftMessage || "";
  },

  clearDraftMessage: (chatId) =>
    set((state) => {
      const chatState = state.chatStates.get(chatId);
      if (!chatState) return state;

      const newChatStates = new Map(state.chatStates);
      newChatStates.set(chatId, { ...chatState, draftMessage: "" });
      return { chatStates: newChatStates };
    }),

  setLastSelectedModel: (chatId, modelId) =>
    set((state) => {
      const chatState = state.chatStates.get(chatId) || { ...defaultChatState };
      const previousModelId = chatState.lastSelectedModelId;
      const newChatStates = new Map(state.chatStates);
      newChatStates.set(chatId, { ...chatState, lastSelectedModelId: modelId });

      if (previousModelId && previousModelId !== modelId) {
        try {
          trackEvent("paprwork_model_changed", {
            from_model: previousModelId,
            to_model: modelId,
          } as Record<string, unknown>);
        } catch { /* ignore */ }
      }

      if (typeof window !== "undefined") {
        try {
          localStorage.setItem("paprwork_last_model_id", modelId);
          // Also save to Gateway settings for reliable persistence
          gateway.send('settings:save-ui-preferences', { lastModelId: modelId }).catch(() => {});
        } catch {
          /* ignore */
        }
      }
      return { chatStates: newChatStates };
    }),

  getLastSelectedModel: (chatId) => {
    const state = get();
    const fromChat = state.chatStates.get(chatId)?.lastSelectedModelId;
    if (fromChat) return fromChat;
    if (typeof window !== "undefined") {
      try {
        const persisted = localStorage.getItem("paprwork_last_model_id");
        if (persisted) return persisted;
      } catch {
        /* ignore */
      }
    }
    return undefined;
  },

  // Load UI preferences from settings (called on app mount)
  loadUIPreferences: async () => {
    try {
      const response = await gateway.send('settings:get', {});
      if (response.success && response.data?.uiPreferences) {
        const { lastModelId } = response.data.uiPreferences;
        if (lastModelId) {
          // Store in localStorage for fast access
          localStorage.setItem("paprwork_last_model_id", lastModelId);
        }
      }
    } catch (error) {
      console.error('[ChatStore] Failed to load UI preferences:', error);
    }
  },

  // ────────────────────────────────────────────────────────────────────────
  // Streaming slice actions
  //
  // All actions replace the streamingState Map so subscribers fire, but
  // selectors should pick narrow values (e.g. .text, or a single toolCall by
  // id) so unrelated chats and unrelated tool rows do NOT re-render.
  // ────────────────────────────────────────────────────────────────────────

  initStreamingState: (chatId, messageId) =>
    set((state) => {
      const next = new Map(state.streamingState);
      next.set(chatId, {
        messageId,
        text: "",
        reasoning: "",
        sequence: [],
        toolCalls: new Map<string, ToolCall>(),
      });
      return { streamingState: next };
    }),

  appendStreamingText: (chatId, delta) =>
    set((state) => {
      const slice = state.streamingState.get(chatId);
      if (!slice) return state;
      const next = new Map(state.streamingState);
      next.set(chatId, { ...slice, text: slice.text + delta });
      return { streamingState: next };
    }),

  setStreamingText: (chatId, text) =>
    set((state) => {
      const slice = state.streamingState.get(chatId);
      if (!slice) return state;
      if (slice.text === text) return state; // no-op short circuit
      const next = new Map(state.streamingState);
      next.set(chatId, { ...slice, text });
      return { streamingState: next };
    }),

  appendStreamingReasoning: (chatId, delta) =>
    set((state) => {
      const slice = state.streamingState.get(chatId);
      if (!slice) return state;
      const next = new Map(state.streamingState);
      next.set(chatId, { ...slice, reasoning: slice.reasoning + delta });
      return { streamingState: next };
    }),

  setStreamingReasoning: (chatId, reasoning) =>
    set((state) => {
      const slice = state.streamingState.get(chatId);
      if (!slice) return state;
      if (slice.reasoning === reasoning) return state;
      const next = new Map(state.streamingState);
      next.set(chatId, { ...slice, reasoning });
      return { streamingState: next };
    }),

  replaceStreamingSequence: (chatId, sequence) =>
    set((state) => {
      const slice = state.streamingState.get(chatId);
      if (!slice) return state;
      const next = new Map(state.streamingState);
      next.set(chatId, { ...slice, sequence });
      return { streamingState: next };
    }),

  upsertStreamingToolCall: (chatId, toolCall) =>
    set((state) => {
      const slice = state.streamingState.get(chatId);
      if (!slice) return state;
      // Mutate map in place is fine because we replace the slice object,
      // and consumers read .toolCalls.get(id) — Map identity check is enough.
      const newToolCalls = new Map(slice.toolCalls);
      newToolCalls.set(toolCall.id, toolCall);
      const next = new Map(state.streamingState);
      next.set(chatId, { ...slice, toolCalls: newToolCalls });
      return { streamingState: next };
    }),

  flushStreamingState: (chatId, overrides) =>
    set((state) => {
      const slice = state.streamingState.get(chatId);
      if (!slice) return state;
      const chatState = state.chatStates.get(chatId);
      if (!chatState) {
        // Nothing to flush into — just clear the slice.
        const next = new Map(state.streamingState);
        next.delete(chatId);
        return { streamingState: next };
      }

      const finalContent = overrides?.content ?? slice.text;
      const finalReasoning = overrides?.reasoning ?? slice.reasoning;
      const finalSequence = overrides?.sequence ?? slice.sequence;
      const finalToolCalls =
        overrides?.toolCalls ?? Array.from(slice.toolCalls.values());

      const updatedMessages = chatState.messages.map((msg) =>
        msg.id === slice.messageId
          ? {
              ...msg,
              content: finalContent || msg.content,
              streamingContent: undefined,
              reasoning: finalReasoning || msg.reasoning,
              streamingReasoning: undefined,
              sequence:
                finalSequence.length > 0 ? finalSequence : msg.sequence,
              toolCalls:
                finalToolCalls.length > 0 ? finalToolCalls : msg.toolCalls,
              isStreaming: overrides?.isStreaming ?? false,
            }
          : msg,
      );

      const newChatStates = new Map(state.chatStates);
      newChatStates.set(chatId, {
        ...chatState,
        messages: updatedMessages,
        isStreaming: overrides?.isStreaming ?? false,
      });

      const newStreaming = new Map(state.streamingState);
      newStreaming.delete(chatId);

      return {
        chatStates: newChatStates,
        streamingState: newStreaming,
      };
    }),

  clearStreamingState: (chatId) =>
    set((state) => {
      if (!state.streamingState.has(chatId)) return state;
      const next = new Map(state.streamingState);
      next.delete(chatId);
      return { streamingState: next };
    }),

  getStreamingState: (chatId) => get().streamingState.get(chatId),
}));

// Expose chatStore globally for tabStore to access
// This avoids circular dependency issues
if (typeof window !== "undefined") {
  (window as any).__chatStore__ = useChatStore.getState();
  useChatStore.subscribe(() => {
    (window as any).__chatStore__ = useChatStore.getState();
  });
}
