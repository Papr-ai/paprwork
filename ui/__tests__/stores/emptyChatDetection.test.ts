/**
 * Tests for Empty Chat Detection in TabStore
 * Tests the centralized logic in createTab() that prevents duplicate empty chats
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore } from "../../stores/chatStore";
import { useTabStore } from "../../stores/tabStore";

describe("Empty Chat Detection in TabStore", () => {
  beforeEach(() => {
    // Reset both stores
    useChatStore.setState({
      activeChat: null,
      chatStates: new Map(),
      chats: [],
      messages: [],
      isLoading: false,
      isSending: false,
      error: null,
    });

    useTabStore.setState({
      tabs: [],
      activeTabId: null,
      splitRatio: 0.5,
      isSplitView: false,
      activeLeftTab: null,
      activeRightTab: null,
    });

    // Setup global window and chat store for tabStore to access
    if (!global.window) {
      (global as any).window = {};
    }
    (global.window as any).__chatStore__ = useChatStore.getState();
  });

  describe("Centralized Empty Chat Detection", () => {
    it("should reuse empty chat when createTab is called", () => {
      // Create first chat with empty state (using temp ID)
      const chatId1 = "temp-123-abc";
      useChatStore.getState().setActiveChat(chatId1);

      // Update global reference
      (global.window as any).__chatStore__ = useChatStore.getState();

      const tabId1 = useTabStore
        .getState()
        .createTab("chat", chatId1, "New Chat");

      expect(useTabStore.getState().tabs.length).toBe(1);
      expect(tabId1).toBe("chat-temp-123-abc");

      // Try to create second temp chat - should reuse first empty one
      const chatId2 = "temp-456-def";
      useChatStore.getState().setActiveChat(chatId2);

      // Update global reference
      (global.window as any).__chatStore__ = useChatStore.getState();

      const tabId2 = useTabStore
        .getState()
        .createTab("chat", chatId2, "New Chat");

      // Should still have only 1 tab (reused the first one)
      expect(useTabStore.getState().tabs.length).toBe(1);
      expect(tabId2).toBe(tabId1); // Returns existing tab ID
    });

    it("should create new chat tab when existing chat has messages", () => {
      // Create first chat and add a message (using temp ID)
      const chatId1 = "temp-123-abc";
      useChatStore.getState().setActiveChat(chatId1);
      useTabStore.getState().createTab("chat", chatId1, "Chat 1");
      useChatStore
        .getState()
        .addMessage({ role: "user", content: "Hello" }, chatId1);

      // Update global reference
      (global.window as any).__chatStore__ = useChatStore.getState();

      expect(useTabStore.getState().tabs.length).toBe(1);

      // Create second temp chat - should create new tab (first has messages)
      const chatId2 = "temp-456-def";
      useChatStore.getState().setActiveChat(chatId2);

      // Update global reference again
      (global.window as any).__chatStore__ = useChatStore.getState();

      const tabId2 = useTabStore
        .getState()
        .createTab("chat", chatId2, "Chat 2");

      // Should now have 2 tabs
      expect(useTabStore.getState().tabs.length).toBe(2);
      expect(tabId2).toBe("chat-temp-456-def");
    });

    it("should find first empty chat among multiple chats", () => {
      // Create Chat 1 with message
      const chatId1 = "chat-1";
      useChatStore.getState().setActiveChat(chatId1);
      useTabStore.getState().createTab("chat", chatId1, "Chat 1");
      useChatStore
        .getState()
        .addMessage({ role: "user", content: "Message 1" }, chatId1);

      // Update global reference
      (global.window as any).__chatStore__ = useChatStore.getState();

      // Create Chat 2 (empty, temp ID)
      const chatId2 = "temp-222-bbb";
      useChatStore.getState().setActiveChat(chatId2);

      // Update global reference
      (global.window as any).__chatStore__ = useChatStore.getState();

      useTabStore.getState().createTab("chat", chatId2, "Chat 2");

      // Create Chat 3 with message (need to bypass empty chat reuse by adding message first)
      const chatId3 = "temp-333-ccc";
      useChatStore.getState().setActiveChat(chatId3);
      // First manually create tab without using createTab to avoid reuse
      useTabStore.setState((state) => ({
        tabs: [
          ...state.tabs,
          {
            id: "chat-temp-333-ccc",
            type: "chat",
            entityId: chatId3,
            title: "Chat 3",
            parentTabId: null,
            childTabIds: [],
            displayMode: "standalone",
            metadata: {},
          },
        ],
        activeTabId: "chat-temp-333-ccc",
        activeLeftTab: "chat-temp-333-ccc",
      }));
      useChatStore
        .getState()
        .addMessage({ role: "user", content: "Message 3" }, chatId3);

      // Update global reference
      (global.window as any).__chatStore__ = useChatStore.getState();

      expect(useTabStore.getState().tabs.length).toBe(3);

      // Try to create new temp chat - should reuse Chat 2 (empty)
      const chatId4 = "temp-444-ddd";
      useChatStore.getState().setActiveChat(chatId4);

      // Update global reference
      (global.window as any).__chatStore__ = useChatStore.getState();

      const tabId4 = useTabStore
        .getState()
        .createTab("chat", chatId4, "Chat 4");

      // Should still have 3 tabs, reused Chat 2
      expect(useTabStore.getState().tabs.length).toBe(3);
      expect(tabId4).toBe("chat-temp-222-bbb"); // Reuses temp-222-bbb
    });
  });

  describe("Non-Chat Tabs", () => {
    it("should not apply empty detection to non-chat tabs", () => {
      // Create document tab
      const tabId1 = useTabStore
        .getState()
        .createTab("document", "doc-1", "Document 1");
      expect(useTabStore.getState().tabs.length).toBe(1);

      // Create another document tab
      const tabId2 = useTabStore
        .getState()
        .createTab("document", "doc-2", "Document 2");
      expect(useTabStore.getState().tabs.length).toBe(2);

      // Both tabs should exist
      expect(tabId1).toBe("document-doc-1");
      expect(tabId2).toBe("document-doc-2");
    });

    it("should reuse static tabs like artifacts and settings", () => {
      // Create artifacts tab
      const tabId1 = useTabStore
        .getState()
        .createTab("document", "artifacts", "Artifacts");
      expect(useTabStore.getState().tabs.length).toBe(1);

      // Try to create artifacts tab again
      const tabId2 = useTabStore
        .getState()
        .createTab("document", "artifacts", "Artifacts");

      // Should reuse existing tab (via existing tab check, not empty chat logic)
      expect(useTabStore.getState().tabs.length).toBe(1);
      expect(tabId2).toBe(tabId1);
    });
  });

  describe("Chat State Initialization", () => {
    it("should have chat state initialized after setActiveChat", () => {
      const chatId = "chat-1";

      // Before activation
      expect(useChatStore.getState().chatStates.has(chatId)).toBe(false);

      // Activate chat
      useChatStore.getState().setActiveChat(chatId);

      // After activation
      expect(useChatStore.getState().chatStates.has(chatId)).toBe(true);
      const state = useChatStore.getState().chatStates.get(chatId);
      expect(state?.messages).toEqual([]);
    });
  });
});
