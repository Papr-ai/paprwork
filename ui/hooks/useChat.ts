/**
 * useChat Hook - Manage chat sessions
 * Handles creating, switching, and managing chat sessions via WebSocket
 */

import { useCallback, useEffect } from "react";
import { useChatStore, defaultChatState } from "../stores/chatStore";
import { useTabStore } from "../stores/tabStore";
import { useAgent } from "./useAgent";
import { gateway } from "../src/lib/gateway";

export function useChat() {
  // V1 APPROACH: Get active chat from tabStore (single source of truth)
  const { activeTabId, getTab } = useTabStore();
  const activeTab = activeTabId ? getTab(activeTabId) : null;
  const activeChat = activeTab?.type === 'chat' ? activeTab.entityId : null;

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
  const chats = useChatStore(s => s.chats);
  const isLoading = useChatStore(s => s.isLoading);
  const error = useChatStore(s => s.error);
  const setChats = useChatStore(s => s.setChats);
  const setLoading = useChatStore(s => s.setLoading);

  const { getHistory } = useAgent();

  // Load all chats
  const loadChats = useCallback(async () => {
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
        // Note: No setActiveChat - tabStore manages active state
      }
    } catch (error) {
      console.error("Failed to load chats:", error);
    } finally {
      setLoading(false);
    }
  }, [setChats, setLoading]); // Fixed: removed activeChat and setActiveChat

  // Load messages for a chat
  const loadMessages = useCallback(
    async (chatId: string) => {
      try {
        setLoading(true);
        const history = await getHistory(chatId);
        
        // Transform CoreMessage to ChatMessage by adding id
        const messages = history.map((msg, index) => ({
          ...msg,
          id: `msg-${index}-${Date.now()}`,
        }));
        
        // Store messages in the specific chat's state using set() with updater function
        useChatStore.setState((state) => {
          const existingState = state.chatStates.get(chatId) || { ...defaultChatState };
          const newChatStates = new Map(state.chatStates);
          newChatStates.set(chatId, {
            ...existingState,
            messages,
            isLoading: false,
          });
          return { chatStates: newChatStates };
        });
      } catch (error) {
        console.error("Failed to load messages:", error);
      } finally {
        setLoading(false);
      }
    },
    [getHistory, setLoading],
  );

  // Load chats on mount
  useEffect(() => {
    loadChats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run once on mount

  // Load messages when active chat changes (driven by tabStore now)
  // BUT: Don't reload if chat already has messages (prevents clobbering in-memory state)
  useEffect(() => {
    console.log(`[useChat.useEffect] Active chat changed to: ${activeChat}`);
    
    if (activeChat) {
      const { chatStates } = useChatStore.getState();
      const existingState = chatStates.get(activeChat);
      
      const messageCount = existingState?.messages?.length || 0;
      console.log(`[useChat.useEffect] Chat state for ${activeChat}:`, {
        hasState: !!existingState,
        messageCount: messageCount,
        isStreaming: existingState?.isStreaming,
        isSending: existingState?.isSending
      });
      
      // Only load if we don't already have messages
      // This prevents wiping out the user message that was just added
      if (!existingState || messageCount === 0) {
        console.log(`[useChat.useEffect] 🔄 Loading messages for ${activeChat}...`);
        loadMessages(activeChat);
      } else {
        console.log(`[useChat.useEffect] ✅ Chat ${activeChat} already has ${messageCount} messages, skipping load`);
      }
    } else {
      console.log(`[useChat.useEffect] No active chat`);
    }
  }, [activeChat, loadMessages]);

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
          await loadChats();
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
        await loadChats();
        // Note: Tab management handled by tabStore (closeTab)
      } catch (error) {
        console.error("Failed to delete chat:", error);
      }
    },
    [loadChats],
  );

  // Switch to different chat
  const switchChat = useCallback(
    (chatId: string) => {
      // V1 APPROACH: Use tabStore to switch tabs (which switches chats)
      const { switchToTab } = useTabStore.getState();
      switchToTab(`chat-${chatId}`);
    },
    [],
  );

  // Update chat title
  const updateChatTitle = useCallback(
    async (chatId: string, title: string) => {
      try {
        await gateway.send("chat:update", { chatId, title });
        await loadChats();
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
  };
}
