/**
 * Empty Chat Detection in TabStore
 *
 * Tests the tabStore's createTab() logic that prevents duplicate empty chats:
 * - When creating a new temp chat tab, reuse an existing empty one
 * - Allow new tabs when existing chats have messages
 * - Non-chat tabs are unaffected
 * - Static tabs (artifacts, settings) deduplicate by entityId
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore, defaultChatState } from "../../stores/chatStore";
import { useTabStore } from "../../stores/tabStore";
import type { ChatState } from "../../types/chat";

/** Initialize a per-chat state entry in the store */
function initChat(chatId: string, overrides: Partial<ChatState> = {}) {
  useChatStore.setState((state) => {
    const next = new Map(state.chatStates);
    next.set(chatId, { ...defaultChatState, ...overrides });
    return { chatStates: next };
  });
}

/** Sync the global __chatStore__ reference that tabStore reads */
function syncGlobal() {
  (global.window as Record<string, unknown>).__chatStore__ =
    useChatStore.getState();
}

describe("Empty Chat Detection in TabStore", () => {
  beforeEach(() => {
    useChatStore.setState({
      chats: [],
      chatStates: new Map(),
      isLoading: false,
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

    if (!global.window) {
      (global as Record<string, unknown>).window = {};
    }
    syncGlobal();
  });

  // ── Reuse Empty Temp Chat ───────────────────────────────────────

  describe("Reuse Empty Temp Chat", () => {
    it("should reuse an existing empty temp chat tab", () => {
      // Create first empty temp chat
      initChat("temp-111");
      syncGlobal();

      const tab1 = useTabStore.getState().createTab("chat", "temp-111", "New Chat");
      expect(useTabStore.getState().tabs).toHaveLength(1);

      // Try to create a second temp chat → should reuse the first
      initChat("temp-222");
      syncGlobal();

      const tab2 = useTabStore.getState().createTab("chat", "temp-222", "New Chat");
      expect(useTabStore.getState().tabs).toHaveLength(1);
      expect(tab2).toBe(tab1);
    });

    it("should create a new tab when existing chat has messages", () => {
      // Create first chat WITH a message
      initChat("temp-111", {
        messages: [{ id: "m1", role: "user", content: "Hello" }],
      });
      syncGlobal();

      useTabStore.getState().createTab("chat", "temp-111", "Chat 1");
      expect(useTabStore.getState().tabs).toHaveLength(1);

      // Create second temp chat → no empty chat to reuse → new tab
      initChat("temp-222");
      syncGlobal();

      const tab2 = useTabStore.getState().createTab("chat", "temp-222", "Chat 2");
      expect(useTabStore.getState().tabs).toHaveLength(2);
      expect(tab2).toBe("chat-temp-222");
    });

    it("should find the first empty chat among mixed chats", () => {
      // Chat 1: has messages
      initChat("chat-1", {
        messages: [{ id: "m1", role: "user", content: "Message 1" }],
      });
      useTabStore.getState().createTab("chat", "chat-1", "Chat 1");

      // Chat 2: empty temp chat
      initChat("temp-222");
      syncGlobal();
      useTabStore.getState().createTab("chat", "temp-222", "Chat 2");

      // Chat 3: has messages (bypass empty-chat logic with non-temp id)
      initChat("chat-3", {
        messages: [{ id: "m3", role: "user", content: "Message 3" }],
      });
      useTabStore.setState((state) => ({
        tabs: [
          ...state.tabs,
          {
            id: "chat-chat-3",
            type: "chat" as const,
            entityId: "chat-3",
            title: "Chat 3",
            parentTabId: null,
            childTabIds: [],
            displayMode: "standalone" as const,
            metadata: {},
          },
        ],
      }));
      syncGlobal();

      expect(useTabStore.getState().tabs).toHaveLength(3);

      // Try to create another temp chat → reuse Chat 2 (empty)
      initChat("temp-444");
      syncGlobal();
      const reusedTab = useTabStore.getState().createTab("chat", "temp-444", "Chat 4");

      expect(useTabStore.getState().tabs).toHaveLength(3);
      expect(reusedTab).toBe("chat-temp-222");
    });
  });

  // ── Non-Chat Tabs ───────────────────────────────────────────────

  describe("Non-Chat Tabs", () => {
    it("should not apply empty detection to non-chat tabs", () => {
      const tab1 = useTabStore.getState().createTab("document", "doc-1", "Document 1");
      const tab2 = useTabStore.getState().createTab("document", "doc-2", "Document 2");

      expect(useTabStore.getState().tabs).toHaveLength(2);
      expect(tab1).toBe("document-doc-1");
      expect(tab2).toBe("document-doc-2");
    });

    it("should reuse static tabs like artifacts and settings", () => {
      const tab1 = useTabStore.getState().createTab("document", "artifacts", "Artifacts");
      const tab2 = useTabStore.getState().createTab("document", "artifacts", "Artifacts");

      expect(useTabStore.getState().tabs).toHaveLength(1);
      expect(tab2).toBe(tab1);
    });
  });

  // ── Chat State Initialization ───────────────────────────────────

  describe("Chat State via getChatState", () => {
    it("should return default state for an uninitialized chatId", () => {
      expect(useChatStore.getState().chatStates.has("unknown")).toBe(false);

      const state = useChatStore.getState().getChatState("unknown");
      expect(state.messages).toEqual([]);
      expect(state.isStreaming).toBe(false);
    });

    it("should return initialized state after setting it", () => {
      initChat("chat-1", {
        messages: [{ id: "m1", role: "user", content: "Test" }],
      });

      const state = useChatStore.getState().getChatState("chat-1");
      expect(state.messages).toHaveLength(1);
    });
  });
});
