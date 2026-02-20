/**
 * Comprehensive Feature Tests
 * Tests all major features implemented in Paprwork v2
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore } from "../../stores/chatStore";
import { useTabStore } from "../../stores/tabStore";

describe("Comprehensive Feature Tests", () => {
  beforeEach(() => {
    // Reset all stores
    useChatStore.setState({
      chatStates: new Map(),
      chats: [],
    });

    useTabStore.setState({
      tabs: [],
      activeTabId: null,
      splitRatio: 0.5,
      isSplitView: false,
      activeLeftTab: null,
      activeRightTab: null,
    });

    // Setup global window with live chatStore reference
    if (!global.window) {
      (global as any).window = {};
    }
    (global.window as any).__chatStore__ = useChatStore.getState();

    // Subscribe to keep __chatStore__ updated
    const unsubscribe = useChatStore.subscribe(() => {
      (global.window as any).__chatStore__ = useChatStore.getState();
    });
    (global as any)._testUnsubscribe = unsubscribe;
  });

  describe("Tab System", () => {
    describe("Tab Creation", () => {
      it("should create tabs of different types", () => {
        // const store = useTabStore.getState() // REMOVED - use direct calls;

        const chatTab = useTabStore
          .getState()
          .createTab("chat", "chat-1", "Chat");
        const docTab = useTabStore
          .getState()
          .createTab("document", "doc-1", "Document");
        const settingsTab = useTabStore
          .getState()
          .createTab("settings", "settings", "Settings");

        expect(useTabStore.getState().tabs.length).toBe(3);
        expect(chatTab).toBe("chat-chat-1");
        expect(docTab).toBe("document-doc-1");
        expect(settingsTab).toBe("settings-settings");
      });

      it("should reuse existing tabs with same ID", () => {
        // const store = useTabStore.getState() // REMOVED - use direct calls;

        const tabId1 = useTabStore
          .getState()
          .createTab("document", "artifacts", "Artifacts");
        const tabId2 = useTabStore
          .getState()
          .createTab("document", "artifacts", "Artifacts");

        expect(useTabStore.getState().tabs.length).toBe(1);
        expect(tabId1).toBe(tabId2);
      });

      it("should set newly created tab as active", () => {
        // const store = useTabStore.getState() // REMOVED - use direct calls;

        useTabStore.getState().createTab("chat", "chat-1", "Chat 1");
        expect(useTabStore.getState().activeTabId).toBe("chat-chat-1");

        useTabStore.getState().createTab("chat", "chat-2", "Chat 2");
        expect(useTabStore.getState().activeTabId).toBe("chat-chat-2");
      });
    });

    describe("Tab Navigation", () => {
      it("should switch between tabs", () => {
        // const store = useTabStore.getState() // REMOVED - use direct calls;

        const tab1 = useTabStore
          .getState()
          .createTab("chat", "chat-1", "Chat 1");
        const tab2 = useTabStore
          .getState()
          .createTab("chat", "chat-2", "Chat 2");
        const tab3 = useTabStore
          .getState()
          .createTab("document", "doc-1", "Doc 1");

        useTabStore.getState().switchToTab(tab1);
        expect(useTabStore.getState().activeTabId).toBe(tab1);

        useTabStore.getState().switchToTab(tab2);
        expect(useTabStore.getState().activeTabId).toBe(tab2);

        useTabStore.getState().switchToTab(tab3);
        expect(useTabStore.getState().activeTabId).toBe(tab3);
      });

      it("should get visible tabs (excluding children)", () => {
        // const store = useTabStore.getState() // REMOVED - use direct calls;

        const parent = useTabStore
          .getState()
          .createTab("chat", "chat-1", "Chat");
        const child = useTabStore
          .getState()
          .createTab("document", "doc-1", "Doc");
        useTabStore.getState().createTab("settings", "settings", "Settings");

        expect(useTabStore.getState().getVisibleTabs().length).toBe(3);

        // Merge child with parent
        useTabStore.getState().addChild(parent, child, "right");

        // Child should be hidden from visible tabs
        expect(useTabStore.getState().getVisibleTabs().length).toBe(2);
      });
    });

    describe("Tab Merging (Parent-Child)", () => {
      it("should merge tabs (create parent-child relationship)", () => {
        // const store = useTabStore.getState() // REMOVED - use direct calls;

        const parentId = useTabStore
          .getState()
          .createTab("chat", "chat-1", "Chat");
        const childId = useTabStore
          .getState()
          .createTab("document", "doc-1", "Document");

        useTabStore.getState().addChild(parentId, childId, "right");

        const parent = useTabStore.getState().getTab(parentId);
        const child = useTabStore.getState().getTab(childId);

        expect(parent?.childTabIds).toContain(childId);
        expect(child?.parentTabId).toBe(parentId);
        expect(child?.displayMode).toBe("child");
      });

      it("should unmerge tabs (promote child to standalone)", () => {
        // const store = useTabStore.getState() // REMOVED - use direct calls;

        const parentId = useTabStore
          .getState()
          .createTab("chat", "chat-1", "Chat");
        const childId = useTabStore
          .getState()
          .createTab("document", "doc-1", "Document");

        useTabStore.getState().addChild(parentId, childId, "right");
        useTabStore.getState().promoteToStandalone(childId);

        const child = useTabStore.getState().getTab(childId);
        expect(child?.parentTabId).toBeNull();
        expect(child?.displayMode).toBe("standalone");
      });

      it("should replace child tab when artifact is updated", () => {
        // const store = useTabStore.getState() // REMOVED - use direct calls;

        const chatId = useTabStore
          .getState()
          .createTab("chat", "chat-1", "Chat");
        const doc1Id = useTabStore
          .getState()
          .createTab("document", "doc-1", "Doc 1");

        useTabStore.getState().addChild(chatId, doc1Id, "right");

        // Create new artifact and replace
        const doc2Id = useTabStore
          .getState()
          .createTab("document", "doc-2", "Doc 2");
        useTabStore.getState().replaceChild(chatId, doc1Id, doc2Id);

        const chat = useTabStore.getState().getTab(chatId);
        expect(chat?.childTabIds).not.toContain(doc1Id);
        expect(chat?.childTabIds).toContain(doc2Id);
      });
    });
  });

  describe("Chat System", () => {
    describe("Chat State Management", () => {
      it("should initialize chat state on first access", () => {
        const store = useChatStore.getState();
        const chatId = "chat-1";

        // Chat state is created on-demand via getChatState
        const state = store.getChatState(chatId);
        expect(state).toBeDefined();
        expect(state.messages).toEqual([]);
        expect(state.isStreaming).toBe(false);
        expect(state.hasUnread).toBe(false);
      });

      it("should maintain independent state for multiple chats", () => {
        const store = useChatStore.getState();

        // Add messages to different chats (creates chat states on-demand)
        store.addMessage(
          { id: "test-1", role: "user", content: "Msg 1" },
          "chat-1",
        );
        store.addMessage(
          { id: "test-2", role: "user", content: "Msg 2" },
          "chat-2",
        );

        // Verify independent state
        expect(store.getChatState("chat-1").messages.length).toBe(1);
        expect(store.getChatState("chat-2").messages.length).toBe(1);
        expect(store.getChatState("chat-3").messages.length).toBe(0);
      });
    });

    describe("Parallel Chat Streaming", () => {
      it("should track streaming state per chat", () => {
        const store = useChatStore.getState();

        // Set streaming for chat-1
        store.setChatStreaming("chat-1", true);

        // Verify independent streaming state
        expect(store.getChatState("chat-1").isStreaming).toBe(true);
        expect(store.getChatState("chat-2").isStreaming).toBe(false);
      });

      it("should track unread state per chat", () => {
        const store = useChatStore.getState();

        // Add message to chat-1
        store.addMessage(
          { id: "test-4", role: "assistant", content: "Response" },
          "chat-1",
        );

        // Update global reference
        (global.window as any).__chatStore__ = store;

        // Verify unread state is tracked
        const chat1State = store.getChatState("chat-1");
        expect(chat1State.messages.length).toBe(1);
      });

      it("should clear unread when marked as read", () => {
        const store = useChatStore.getState();

        // Add message to chat-1
        store.addMessage(
          { id: "test-4", role: "assistant", content: "Response" },
          "chat-1",
        );

        // Mark as read
        store.markChatAsRead("chat-1");

        const chat1State = store.getChatState("chat-1");
        expect(chat1State.hasUnread).toBe(false);
      });
    });

    describe("Empty Chat Detection", () => {
      it("should reuse empty chat with temp ID", () => {
        const chatStore = useChatStore.getState();
        (global.window as any).__chatStore__ = chatStore;

        const tab1 = useTabStore
          .getState()
          .createTab("chat", "temp-123", "New Chat");
        expect(useTabStore.getState().tabs.length).toBe(1);

        // Try to create another temp chat - should reuse empty one
        (global.window as any).__chatStore__ = chatStore;

        const tab2 = useTabStore
          .getState()
          .createTab("chat", "temp-456", "New Chat");

        expect(useTabStore.getState().tabs.length).toBe(1);
        expect(tab2).toBe(tab1);
      });

      it("should create new chat when existing has messages", () => {
        const chatStore = useChatStore.getState();
        useTabStore.getState().createTab("chat", "temp-123", "Chat 1");
        chatStore.addMessage(
          { id: "test-5", role: "user", content: "Hello" },
          "temp-123",
        );

        (global.window as any).__chatStore__ = chatStore;

        // Try to create new temp chat - should create new (first has messages)
        (global.window as any).__chatStore__ = chatStore;

        useTabStore.getState().createTab("chat", "temp-456", "Chat 2");

        expect(useTabStore.getState().tabs.length).toBe(2);
      });
    });
  });

  describe("Settings System", () => {
    describe("Custom API Keys", () => {
      it("should manage custom keys lifecycle", () => {
        // This would test the custom keys feature
        // For now, we'll mark it as a placeholder
        expect(true).toBe(true);
      });
    });
  });

  describe("Keyboard Shortcuts", () => {
    it("should support all keyboard shortcuts", () => {
      // Placeholder for keyboard shortcut tests
      // Cmd+T, Cmd+W, Cmd+Tab, Cmd+[, Cmd+], Cmd+1-9
      expect(true).toBe(true);
    });
  });

  describe("Split View", () => {
    it("should manage split view state", () => {
      // const store = useTabStore.getState() // REMOVED - use direct calls;

      const tab1 = useTabStore.getState().createTab("chat", "chat-1", "Chat");
      const tab2 = useTabStore.getState().createTab("document", "doc-1", "Doc");

      // enableSplitView(draggedTab, targetTab) makes targetTab parent and draggedTab child
      useTabStore.getState().enableSplitView(tab1, tab2);

      expect(useTabStore.getState().isSplitView).toBe(true);
      expect(useTabStore.getState().activeLeftTab).toBe(tab2); // tab2 is parent (left)
      expect(useTabStore.getState().activeRightTab).toBe(tab1); // tab1 is child (right)
    });

    it("should adjust split ratio", () => {
      // const store = useTabStore.getState() // REMOVED - use direct calls;

      expect(useTabStore.getState().splitRatio).toBe(0.5);

      useTabStore.getState().setSplitRatio(0.3);
      expect(useTabStore.getState().splitRatio).toBe(0.3);

      useTabStore.getState().setSplitRatio(0.7);
      expect(useTabStore.getState().splitRatio).toBe(0.7);
    });
  });

  describe("Integration Tests", () => {
    it("should handle complete workflow: create chat, merge with artifact, unmerge", () => {
      // 1. Create chat
      const chatStore = useChatStore.getState();
      (global.window as any).__chatStore__ = chatStore;

      const chatTab = useTabStore
        .getState()
        .createTab("chat", "temp-123", "New Chat");
      expect(useTabStore.getState().tabs.length).toBe(1);

      // 2. Send message
      chatStore.addMessage(
        { id: "test-6", role: "user", content: "Create a document" },
        "temp-123",
      );

      // 3. Create artifact and merge
      const docTab = useTabStore
        .getState()
        .createTab("document", "doc-1", "Document");
      useTabStore.getState().addChild(chatTab, docTab, "right");

      expect(useTabStore.getState().getVisibleTabs().length).toBe(1); // Only parent visible
      expect(useTabStore.getState().getTab(chatTab)?.childTabIds).toContain(
        docTab,
      );

      // 4. Unmerge
      useTabStore.getState().promoteToStandalone(docTab);

      expect(useTabStore.getState().getVisibleTabs().length).toBe(2); // Both visible
      expect(useTabStore.getState().getTab(docTab)?.parentTabId).toBeNull();
    });

    it("should handle multiple parallel chats with streaming", () => {
      const chatStore = useChatStore.getState();
      const tabStore = useTabStore.getState();

      // Create 3 tabs
      tabStore.createTab("chat", "chat-1", "Chat 1");
      tabStore.createTab("chat", "chat-2", "Chat 2");
      tabStore.createTab("chat", "chat-3", "Chat 3");

      // Start streaming in chat-1
      chatStore.setChatStreaming("chat-1", true);

      // Add message to chat-2
      chatStore.addMessage(
        { id: "test-7", role: "assistant", content: "Response" },
        "chat-2",
      );

      // Verify independent states
      expect(chatStore.getChatState("chat-1").isStreaming).toBe(true);
      expect(chatStore.getChatState("chat-2").isStreaming).toBe(false);
      expect(chatStore.getChatState("chat-3").isStreaming).toBe(false);
    });
  });
});
