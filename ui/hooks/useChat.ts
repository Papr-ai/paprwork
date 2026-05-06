/**
 * useChat Hook - Manage chat sessions
 * Handles creating, switching, and managing chat sessions via WebSocket
 */

import { useCallback, useEffect } from "react";
import { useChatStore, defaultChatState } from "../stores/chatStore";
import { useTabStore } from "../stores/tabStore";
import { gateway } from "../src/lib/gateway";
import { mapHistoryMessages } from "../utils/historyMapper";
import { fetchChatHistory } from "../utils/chatHistoryApi";

let hasLoadedChatsOnce = false;
let loadChatsPromise: Promise<void> | null = null;

export function useChat() {
  // V1 APPROACH: Get active chat from tabStore (single source of truth)
  const { activeLeftTab, activeTabId, getTab } = useTabStore();
  const selectedTabId = activeLeftTab || activeTabId;
  const activeTab = selectedTabId ? getTab(selectedTabId) : null;
  const activeChat = activeTab?.type === "chat" ? activeTab.entityId : null;

  // Get messages for the ACTIVE chat specifically (not global messages array)
  // Use selector to only re-render when THIS chat's messages change
  const messages = useChatStore((state) => {
    if (!activeChat) return [];
    const chatState = state.chatStates.get(activeChat);
    return chatState?.messages || [];
  });

  // Get isSending for the ACTIVE chat only (not global)
  const isSending = useChatStore((state) => {
    if (!activeChat) return false;
    const chatState = state.chatStates.get(activeChat);
    return chatState?.isSending || false;
  });

  // Subscribe to each piece of state separately to avoid unnecessary re-renders
  const chats = useChatStore((s) => s.chats);
  const isLoading = useChatStore((s) => s.isLoading);
  const error = useChatStore((s) => s.error);
  const setChats = useChatStore((s) => s.setChats);
  const setLoading = useChatStore((s) => s.setLoading);

  // Load all chats
  const loadChats = useCallback(
    async (force: boolean = false) => {
      if (hasLoadedChatsOnce && !force) {
        return;
      }
      if (loadChatsPromise && !force) {
        await loadChatsPromise;
        return;
      }

      loadChatsPromise = (async () => {
        try {
          setLoading(true);
          const response = await gateway.send("chat:list");
          const chatsList = response.data as Array<{
            id: string;
            title: string;
            createdAt: string;
            updatedAt: string;
          }>;

          if (chatsList) {
            setChats(chatsList);
            hasLoadedChatsOnce = true;
            // Note: No setActiveChat - tabStore manages active state
          }
        } catch (error) {
          console.error("Failed to load chats:", error);
        } finally {
          setLoading(false);
          loadChatsPromise = null;
        }
      })();

      await loadChatsPromise;
    },
    [setChats, setLoading],
  ); // Fixed: removed activeChat and setActiveChat

  // Load messages for a chat (loads only recent messages)
  const loadMessages = useCallback(
    async (chatId: string, limit: number = 30) => {
      try {
        setLoading(true);
        useChatStore.setState((state) => {
          const existingState = state.chatStates.get(chatId) || {
            ...defaultChatState,
          };
          const newChatStates = new Map(state.chatStates);
          newChatStates.set(chatId, {
            ...existingState,
            isLoading: true,
          });
          return { chatStates: newChatStates };
        });

        const history = await fetchChatHistory(chatId, { limit });

        const messages = mapHistoryMessages(history);

        // Store messages in the specific chat's state using set() with updater function
        useChatStore.setState((state) => {
          const existingState = state.chatStates.get(chatId) || {
            ...defaultChatState,
          };
          const newChatStates = new Map(state.chatStates);
          newChatStates.set(chatId, {
            ...existingState,
            messages,
            isLoading: false,
            hasMoreMessages: messages.length === limit, // If we got exactly 'limit' messages, there might be more
          });
          return { chatStates: newChatStates };
        });
      } catch (error) {
        console.error("Failed to load messages:", error);
      } finally {
        useChatStore.setState((state) => {
          const existingState = state.chatStates.get(chatId) || {
            ...defaultChatState,
          };
          const newChatStates = new Map(state.chatStates);
          newChatStates.set(chatId, {
            ...existingState,
            isLoading: false,
          });
          return { chatStates: newChatStates };
        });
        setLoading(false);
      }
    },
    [setLoading],
  );

  // Load older messages for pagination
  const loadOlderMessages = useCallback(
    async (chatId: string, batchSize: number = 20) => {
      const chatState = useChatStore.getState().chatStates.get(chatId);
      if (!chatState || !chatState.hasMoreMessages || chatState.isLoadingMore) {
        return;
      }

      try {
        useChatStore.getState().setLoadingMore(chatId, true);

        const currentMessageCount = chatState.messages.length;
        const history = await fetchChatHistory(chatId, {
          limit: batchSize,
          skip: currentMessageCount,
        });

        const olderMessages = mapHistoryMessages(history);

        if (olderMessages.length === 0) {
          // No more messages to load
          useChatStore.getState().setHasMoreMessages(chatId, false);
        } else {
          // Prepend older messages to the beginning
          useChatStore.getState().prependMessages(olderMessages, chatId);
          
          // If we got fewer messages than requested, we've reached the beginning
          if (olderMessages.length < batchSize) {
            useChatStore.getState().setHasMoreMessages(chatId, false);
          }
        }
      } catch (error) {
        console.error("Failed to load older messages:", error);
      } finally {
        useChatStore.getState().setLoadingMore(chatId, false);
      }
    },
    [],
  );

  // Load chats on mount
  useEffect(() => {
    loadChats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run once on mount

  // Listen for chat list updates broadcast from Gateway
  useEffect(() => {
    const handleBroadcast = (event: Event) => {
      const customEvent = event as CustomEvent;
      if (customEvent.detail?.type === "chat:list-updated") {
        console.log("[useChat] Received chat list update broadcast, reloading...");
        loadChats(true); // Force reload
      }
    };

    window.addEventListener("gateway-broadcast", handleBroadcast);
    return () => {
      window.removeEventListener("gateway-broadcast", handleBroadcast);
    };
  }, [loadChats]);

  // IMPORTANT:
  // Message hydration is handled by each ChatContainer instance per chatId.
  // Keeping it there avoids duplicate fetch storms from multiple useChat consumers.

  // Create new chat
  const createChat = useCallback(
    async (title?: string, returnTempId: boolean = true) => {
      // V1 APPROACH: Just return temp ID, tabStore will handle activation
      if (returnTempId) {
        // Use timestamp + random number to ensure uniqueness even if multiple
        // chats are created in the same millisecond
        const tempId = `temp-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        // Initialize empty chat state for this new chat
        const { chatStates } = useChatStore.getState();
        const newChatStates = new Map(chatStates);
        newChatStates.set(tempId, {
          messages: [],
          isLoading: false,
          isSending: false,
          isStreaming: false,
          hasUnread: false,
        });
        useChatStore.setState({ chatStates: newChatStates });
        return tempId;
      }

      // Create actual chat in backend (called when first message is sent)
      try {
        const response = await gateway.send("chat:create", { title });
        const chat = response.data as { chatId: string };

        if (chat?.chatId) {
          await loadChats(true);
          return chat.chatId;
        }
        throw new Error("Failed to create chat");
      } catch (error) {
        console.error("Failed to create chat:", error);
        return null;
      }
    },
    [loadChats],
  );

  // Delete chat
  const deleteChat = useCallback(
    async (chatId: string) => {
      try {
        await gateway.send("chat:delete", { chatId });
        await loadChats(true);
        // Note: Tab management handled by tabStore (closeTab)
      } catch (error) {
        console.error("Failed to delete chat:", error);
      }
    },
    [loadChats],
  );

  // Switch to different chat
  const switchChat = useCallback((chatId: string) => {
    // V1 APPROACH: Use tabStore to switch tabs (which switches chats)
    const { switchToTab } = useTabStore.getState();
    switchToTab(`chat-${chatId}`);
  }, []);

  // Update chat title
  const updateChatTitle = useCallback(
    async (chatId: string, title: string) => {
      try {
        await gateway.send("chat:update", { chatId, title });
        await loadChats(true);
      } catch (error) {
        console.error("Failed to update chat title:", error);
      }
    },
    [loadChats],
  );

  return {
    // State
    activeChat,
    messages,
    chats,
    isSending,
    isLoading,
    error,

    // Actions
    createChat,
    deleteChat,
    switchChat,
    updateChatTitle,
    loadChats,
    loadMessages,
    loadOlderMessages,
  };
}
