/**
 * Chat Store - Global state management for chat UI
 * Uses Zustand for simple, performant state management
 * Supports parallel chat streaming with per-chat state
 */

import { create } from "zustand";
import type { ChatMetadata, ChatMessage, ChatState } from "../types/chat";

// Re-export types for backward compatibility
export type { ChatMetadata, ChatMessage, ChatState };

interface ChatStore {
  // All chat metadata
  chats: ChatMetadata[];

  // Per-chat state for parallel streaming (keyed by chatId)
  chatStates: Map<string, ChatState>;

  // UI state (global - only for non-chat-specific loading/errors)
  isLoading: boolean;
  error: string | null;

  // Actions
  addMessage: (message: ChatMessage, chatId?: string) => void;
  updateStreamingMessage: (
    messageId: string,
    content: string,
    chatId?: string,
  ) => void;
  finalizeStreamingMessage: (messageId: string, chatId?: string) => void;
  setChats: (chats: ChatMetadata[]) => void;
  setLoading: (loading: boolean) => void;
  setSending: (chatId: string, sending: boolean) => void;
  setError: (error: string | null) => void;

  // Parallel chat state management
  setChatStreaming: (chatId: string, isStreaming: boolean) => void;
  setChatUnread: (chatId: string, hasUnread: boolean) => void;
  markChatAsRead: (chatId: string) => void;
  getChatState: (chatId: string) => ChatState;

  // Draft message management
  setDraftMessage: (chatId: string, draft: string) => void;
  getDraftMessage: (chatId: string) => string;
  clearDraftMessage: (chatId: string) => void;
}

export const defaultChatState: ChatState = {
  messages: [],
  isLoading: false,
  isSending: false,
  isStreaming: false,
  hasUnread: false,
};

export const useChatStore = create<ChatStore>((set, get) => ({
  // Initial state
  chats: [],
  chatStates: new Map(),
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

  setChats: (chats) =>
    set(() => ({
      chats,
    })),

  setLoading: (loading) => set({ isLoading: loading }),

  setSending: (chatId, sending) =>
    set((state) => {
      const chatState = state.chatStates.get(chatId);
      if (!chatState) {
        console.warn(`[chatStore] setSending: No chat state for ${chatId}`);
        return state;
      }

      const newChatStates = new Map(state.chatStates);
      newChatStates.set(chatId, {
        ...chatState,
        isSending: sending,
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
}));

// Expose chatStore globally for tabStore to access
// This avoids circular dependency issues
if (typeof window !== "undefined") {
  (window as any).__chatStore__ = useChatStore.getState();
  useChatStore.subscribe(() => {
    (window as any).__chatStore__ = useChatStore.getState();
  });
}
