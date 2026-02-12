/**
 * Creator Stays Logic Tests
 * Verifies the "creator stays, other replaces" rule for tab merging
 * Chat/Meeting/Artifact can be on any side, and when creating artifacts,
 * the creator stays in place and the other pane is replaced.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useTabStore } from "../../stores/tabStore";
import { useChatStore } from "../../stores/chatStore";

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
      activeChat: null,
      messages: [],
      chatStates: new Map(),
      error: null,
    });

    // Setup global window mock
    if (!(global as any).window) {
      (global as any).window = {};
    }
    (global.window as any).__chatStore__ = useChatStore.getState();
  });

  describe("Chat Can Be on Any Side", () => {
    it("should allow chat as parent with document on right", () => {
      useChatStore.getState().setActiveChat("chat-1");
      (global.window as any).__chatStore__ = useChatStore.getState();

      const chatTab = useTabStore
        .getState()
        .createTab("chat", "chat-1", "Chat");
      const docTab = useTabStore
        .getState()
        .createTab("document", "doc-1", "Document");

      // Merge document to right of chat
      useTabStore.getState().addChild(chatTab, docTab, "right");

      const chat = useTabStore.getState().getTab(chatTab);
      const doc = useTabStore.getState().getTab(docTab);

      expect(chat?.displayMode).toBe("parent");
      expect(chat?.childTabIds).toContain(docTab);
      expect(doc?.displayMode).toBe("child");
      expect(doc?.position).toBe("right");
    });

    it("should allow chat as child (no auto-swap)", () => {
      // Create document and chat
      const docTab = useTabStore
        .getState()
        .createTab("document", "doc-1", "Document");

      useChatStore.getState().setActiveChat("chat-1");
      (global.window as any).__chatStore__ = useChatStore.getState();

      const chatTab = useTabStore
        .getState()
        .createTab("chat", "chat-1", "Chat");

      // Merge chat as child of document - should NOT auto-swap
      useTabStore.getState().addChild(docTab, chatTab, "right");

      const chat = useTabStore.getState().getTab(chatTab);
      const doc = useTabStore.getState().getTab(docTab);

      // No swap: doc is parent, chat is child
      expect(doc?.displayMode).toBe("parent");
      expect(doc?.childTabIds).toContain(chatTab);
      expect(chat?.displayMode).toBe("child");
      expect(chat?.parentTabId).toBe(docTab);
      expect(chat?.position).toBe("right");
    });
  });

  describe("Creator Stays: Chat Creates Artifacts", () => {
    it("should keep chat and replace artifact when chat is parent", () => {
      useChatStore.getState().setActiveChat("chat-1");
      (global.window as any).__chatStore__ = useChatStore.getState();

      const chatTab = useTabStore
        .getState()
        .createTab("chat", "chat-1", "Chat");
      const doc1Tab = useTabStore
        .getState()
        .createTab("document", "doc-1", "Document 1");

      // Merge first document
      useTabStore.getState().createArtifactFromChat(chatTab, doc1Tab);

      expect(useTabStore.getState().tabs.length).toBe(2);

      // Create second artifact - should replace first
      const doc2Tab = useTabStore
        .getState()
        .createTab("document", "doc-2", "Document 2");
      useTabStore.getState().createArtifactFromChat(chatTab, doc2Tab);

      const chat = useTabStore.getState().getTab(chatTab);
      const doc2 = useTabStore.getState().getTab(doc2Tab);
      const doc1 = useTabStore.getState().getTab(doc1Tab);

      expect(chat?.displayMode).toBe("parent");
      expect(chat?.childTabIds).toContain(doc2Tab);
      expect(chat?.childTabIds).not.toContain(doc1Tab);
      expect(doc2?.displayMode).toBe("child");
      expect(doc1).toBeUndefined(); // Old doc removed
      expect(useTabStore.getState().tabs.length).toBe(2); // Max 2 panes
    });

    it("should keep chat in same position when replacing parent with artifact", () => {
      const docTab = useTabStore
        .getState()
        .createTab("document", "doc-1", "Document");

      useChatStore.getState().setActiveChat("chat-1");
      (global.window as any).__chatStore__ = useChatStore.getState();

      const chatTab = useTabStore
        .getState()
        .createTab("chat", "chat-1", "Chat");

      // Merge chat as child of document on right
      useTabStore.getState().addChild(docTab, chatTab, "right");

      expect(useTabStore.getState().getTab(chatTab)?.displayMode).toBe("child");
      expect(useTabStore.getState().getTab(chatTab)?.position).toBe("right");

      // Chat creates artifact - artifact becomes parent, chat stays as child on right
      const artifactTab = useTabStore
        .getState()
        .createTab("document", "artifact-1", "Artifact");
      useTabStore.getState().createArtifactFromChat(chatTab, artifactTab);

      const chat = useTabStore.getState().getTab(chatTab);
      const artifact = useTabStore.getState().getTab(artifactTab);
      const doc = useTabStore.getState().getTab(docTab);

      // Artifact is now parent
      expect(artifact?.displayMode).toBe("parent");
      expect(artifact?.parentTabId).toBeNull();
      expect(artifact?.childTabIds).toContain(chatTab);

      // Chat stayed as child in SAME position (right)
      expect(chat?.displayMode).toBe("child");
      expect(chat?.parentTabId).toBe(artifactTab);
      expect(chat?.position).toBe("right"); // Same position!

      // Doc removed (the OTHER pane)
      expect(doc).toBeUndefined();
      expect(useTabStore.getState().tabs.length).toBe(2); // Max 2 panes
    });
  });

  describe("Creator Stays: Sequential Artifacts", () => {
    it("should replace artifacts sequentially (max 1 child)", () => {
      useChatStore.getState().setActiveChat("chat-1");
      (global.window as any).__chatStore__ = useChatStore.getState();

      const chatTab = useTabStore
        .getState()
        .createTab("chat", "chat-1", "Chat");

      // Create first artifact
      const art1Tab = useTabStore
        .getState()
        .createTab("document", "doc-1", "Artifact 1");
      useTabStore.getState().createArtifactFromChat(chatTab, art1Tab);

      expect(useTabStore.getState().tabs.length).toBe(2); // chat + art1

      // Create second artifact (should replace first due to max-1-child)
      const art2Tab = useTabStore
        .getState()
        .createTab("document", "doc-2", "Artifact 2");
      useTabStore.getState().createArtifactFromChat(chatTab, art2Tab);

      expect(useTabStore.getState().tabs.length).toBe(2); // chat + art2
      expect(useTabStore.getState().getTab(art1Tab)).toBeUndefined();

      const chat = useTabStore.getState().getTab(chatTab);
      expect(chat?.childTabIds).toEqual([art2Tab]);
    });

    it("should create third artifact, replacing second", () => {
      useChatStore.getState().setActiveChat("chat-1");
      (global.window as any).__chatStore__ = useChatStore.getState();

      const chatTab = useTabStore
        .getState()
        .createTab("chat", "chat-1", "Chat");

      // Create artifacts 1, 2, 3 sequentially
      const art1 = useTabStore
        .getState()
        .createTab("document", "art-1", "Artifact 1");
      useTabStore.getState().createArtifactFromChat(chatTab, art1);

      const art2 = useTabStore
        .getState()
        .createTab("document", "art-2", "Artifact 2");
      useTabStore.getState().createArtifactFromChat(chatTab, art2);

      const art3 = useTabStore
        .getState()
        .createTab("document", "art-3", "Artifact 3");
      useTabStore.getState().createArtifactFromChat(chatTab, art3);

      // Only art3 should exist
      expect(useTabStore.getState().tabs.length).toBe(2);
      expect(useTabStore.getState().getTab(art1)).toBeUndefined();
      expect(useTabStore.getState().getTab(art2)).toBeUndefined();
      expect(useTabStore.getState().getTab(art3)).toBeDefined();

      const chat = useTabStore.getState().getTab(chatTab);
      expect(chat?.childTabIds).toEqual([art3]);
    });
  });

  describe("Flexible Tab Types", () => {
    it("should allow any tab type as parent or child", () => {
      // Meeting as parent, document as child
      const meetingTab = useTabStore
        .getState()
        .createTab("meeting", "meet-1", "Meeting");
      const docTab = useTabStore
        .getState()
        .createTab("document", "doc-1", "Document");

      useTabStore.getState().addChild(meetingTab, docTab, "right");

      const meeting = useTabStore.getState().getTab(meetingTab);
      const doc = useTabStore.getState().getTab(docTab);

      expect(meeting?.displayMode).toBe("parent");
      expect(doc?.displayMode).toBe("child");
    });

    it("should allow document as parent with chat as child", () => {
      const docTab = useTabStore
        .getState()
        .createTab("document", "doc-1", "Document");

      useChatStore.getState().setActiveChat("chat-1");
      (global.window as any).__chatStore__ = useChatStore.getState();

      const chatTab = useTabStore
        .getState()
        .createTab("chat", "chat-1", "Chat");

      useTabStore.getState().addChild(docTab, chatTab, "right");

      const doc = useTabStore.getState().getTab(docTab);
      const chat = useTabStore.getState().getTab(chatTab);

      expect(doc?.displayMode).toBe("parent");
      expect(chat?.displayMode).toBe("child");
      expect(chat?.position).toBe("right");
    });
  });
});
