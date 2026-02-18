/**
 * Creator Stays Logic Tests
 *
 * Tests the "creator stays, other replaces" rule for tab merging:
 * - Chat/Meeting/Artifact can be on any side
 * - When creating artifacts, the creator stays in place and the other pane is replaced
 * - Sequential artifact creation replaces the previous artifact (max 1 child)
 * - Any tab type can be parent or child (flexible)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useTabStore } from "../../stores/tabStore";
import { useChatStore, defaultChatState } from "../../stores/chatStore";
import type { ChatState } from "../../types/chat";

/** Initialize a per-chat state entry so the tabStore sees it via __chatStore__ */
function initChat(chatId: string, overrides: Partial<ChatState> = {}) {
  useChatStore.setState((state) => {
    const next = new Map(state.chatStates);
    next.set(chatId, { ...defaultChatState, ...overrides });
    return { chatStates: next };
  });
  syncGlobal();
}

/** Sync the global __chatStore__ reference that tabStore reads */
function syncGlobal() {
  (global.window as Record<string, unknown>).__chatStore__ =
    useChatStore.getState();
}

describe("Creator Stays Logic (Simplified UX)", () => {
  beforeEach(() => {
    useTabStore.setState({
      tabs: [],
      activeTabId: null,
      activeLeftTab: null,
      activeRightTab: null,
      isSplitView: false,
      splitRatio: 0.5,
    });

    useChatStore.setState({
      chats: [],
      chatStates: new Map(),
      error: null,
      isLoading: false,
    });

    if (!(global as Record<string, unknown>).window) {
      (global as Record<string, unknown>).window = {};
    }
    syncGlobal();
  });

  // ── Chat Can Be on Any Side ─────────────────────────────────────

  describe("Chat Can Be on Any Side", () => {
    it("should allow chat as parent with document on right", () => {
      initChat("chat-1");

      const chatTab = useTabStore.getState().createTab("chat", "chat-1", "Chat");
      const docTab = useTabStore.getState().createTab("document", "doc-1", "Document");

      useTabStore.getState().addChild(chatTab, docTab, "right");

      const chat = useTabStore.getState().getTab(chatTab);
      const doc = useTabStore.getState().getTab(docTab);

      expect(chat?.displayMode).toBe("parent");
      expect(chat?.childTabIds).toContain(docTab);
      expect(doc?.displayMode).toBe("child");
      expect(doc?.position).toBe("right");
    });

    it("should allow chat as child (no auto-swap)", () => {
      const docTab = useTabStore.getState().createTab("document", "doc-1", "Document");

      initChat("chat-1");
      const chatTab = useTabStore.getState().createTab("chat", "chat-1", "Chat");

      useTabStore.getState().addChild(docTab, chatTab, "right");

      const chat = useTabStore.getState().getTab(chatTab);
      const doc = useTabStore.getState().getTab(docTab);

      expect(doc?.displayMode).toBe("parent");
      expect(doc?.childTabIds).toContain(chatTab);
      expect(chat?.displayMode).toBe("child");
      expect(chat?.parentTabId).toBe(docTab);
      expect(chat?.position).toBe("right");
    });
  });

  // ── Creator Stays: Chat Creates Artifacts ───────────────────────

  describe("Creator Stays: Chat Creates Artifacts", () => {
    it("should keep chat and replace artifact when chat is parent", () => {
      initChat("chat-1");

      const chatTab = useTabStore.getState().createTab("chat", "chat-1", "Chat");
      const doc1Tab = useTabStore.getState().createTab("document", "doc-1", "Document 1");

      useTabStore.getState().createArtifactFromChat(chatTab, doc1Tab);
      expect(useTabStore.getState().tabs).toHaveLength(2);

      // Second artifact replaces first
      const doc2Tab = useTabStore.getState().createTab("document", "doc-2", "Document 2");
      useTabStore.getState().createArtifactFromChat(chatTab, doc2Tab);

      const chat = useTabStore.getState().getTab(chatTab);
      expect(chat?.displayMode).toBe("parent");
      expect(chat?.childTabIds).toContain(doc2Tab);
      expect(chat?.childTabIds).not.toContain(doc1Tab);
      expect(useTabStore.getState().getTab(doc1Tab)).toBeUndefined();
      expect(useTabStore.getState().tabs).toHaveLength(2);
    });

    it("should keep chat in same position when replacing parent with artifact", () => {
      const docTab = useTabStore.getState().createTab("document", "doc-1", "Document");

      initChat("chat-1");
      const chatTab = useTabStore.getState().createTab("chat", "chat-1", "Chat");

      useTabStore.getState().addChild(docTab, chatTab, "right");
      expect(useTabStore.getState().getTab(chatTab)?.displayMode).toBe("child");
      expect(useTabStore.getState().getTab(chatTab)?.position).toBe("right");

      // Chat creates artifact → artifact becomes parent, chat stays as child on right
      const artifactTab = useTabStore.getState().createTab("document", "artifact-1", "Artifact");
      useTabStore.getState().createArtifactFromChat(chatTab, artifactTab);

      const chat = useTabStore.getState().getTab(chatTab);
      const artifact = useTabStore.getState().getTab(artifactTab);

      expect(artifact?.displayMode).toBe("parent");
      expect(artifact?.parentTabId).toBeNull();
      expect(artifact?.childTabIds).toContain(chatTab);

      expect(chat?.displayMode).toBe("child");
      expect(chat?.parentTabId).toBe(artifactTab);
      expect(chat?.position).toBe("right");

      expect(useTabStore.getState().getTab(docTab)).toBeUndefined();
      expect(useTabStore.getState().tabs).toHaveLength(2);
    });
  });

  // ── Creator Stays: Sequential Artifacts ─────────────────────────

  describe("Creator Stays: Sequential Artifacts", () => {
    it("should replace artifacts sequentially (max 1 child)", () => {
      initChat("chat-1");
      const chatTab = useTabStore.getState().createTab("chat", "chat-1", "Chat");

      const art1 = useTabStore.getState().createTab("document", "doc-1", "Artifact 1");
      useTabStore.getState().createArtifactFromChat(chatTab, art1);
      expect(useTabStore.getState().tabs).toHaveLength(2);

      const art2 = useTabStore.getState().createTab("document", "doc-2", "Artifact 2");
      useTabStore.getState().createArtifactFromChat(chatTab, art2);

      expect(useTabStore.getState().tabs).toHaveLength(2);
      expect(useTabStore.getState().getTab(art1)).toBeUndefined();
      expect(useTabStore.getState().getTab(chatTab)?.childTabIds).toEqual([art2]);
    });

    it("should create third artifact, replacing second", () => {
      initChat("chat-1");
      const chatTab = useTabStore.getState().createTab("chat", "chat-1", "Chat");

      const art1 = useTabStore.getState().createTab("document", "art-1", "Artifact 1");
      useTabStore.getState().createArtifactFromChat(chatTab, art1);

      const art2 = useTabStore.getState().createTab("document", "art-2", "Artifact 2");
      useTabStore.getState().createArtifactFromChat(chatTab, art2);

      const art3 = useTabStore.getState().createTab("document", "art-3", "Artifact 3");
      useTabStore.getState().createArtifactFromChat(chatTab, art3);

      expect(useTabStore.getState().tabs).toHaveLength(2);
      expect(useTabStore.getState().getTab(art1)).toBeUndefined();
      expect(useTabStore.getState().getTab(art2)).toBeUndefined();
      expect(useTabStore.getState().getTab(art3)).toBeDefined();
      expect(useTabStore.getState().getTab(chatTab)?.childTabIds).toEqual([art3]);
    });
  });

  // ── Flexible Tab Types ──────────────────────────────────────────

  describe("Flexible Tab Types", () => {
    it("should allow any tab type as parent or child", () => {
      const meetingTab = useTabStore.getState().createTab("meeting", "meet-1", "Meeting");
      const docTab = useTabStore.getState().createTab("document", "doc-1", "Document");

      useTabStore.getState().addChild(meetingTab, docTab, "right");

      expect(useTabStore.getState().getTab(meetingTab)?.displayMode).toBe("parent");
      expect(useTabStore.getState().getTab(docTab)?.displayMode).toBe("child");
    });

    it("should allow document as parent with chat as child", () => {
      const docTab = useTabStore.getState().createTab("document", "doc-1", "Document");

      initChat("chat-1");
      const chatTab = useTabStore.getState().createTab("chat", "chat-1", "Chat");

      useTabStore.getState().addChild(docTab, chatTab, "right");

      expect(useTabStore.getState().getTab(docTab)?.displayMode).toBe("parent");
      expect(useTabStore.getState().getTab(chatTab)?.displayMode).toBe("child");
      expect(useTabStore.getState().getTab(chatTab)?.position).toBe("right");
    });
  });
});
