/**
 * Comprehensive Tab Merging Tests
 * Tests parent-child relationships and edge cases
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useTabStore } from "../../stores/tabStore";

describe("Tab Merging (Parent-Child Relationships)", () => {
  beforeEach(() => {
    // Reset store
    useTabStore.setState({
      tabs: [],
      activeTabId: null,
      splitRatio: 0.5,
      isSplitView: false,
      activeLeftTab: null,
      activeRightTab: null,
    });

    // Setup global window
    if (!global.window) {
      (global as any).window = {};
    }
    (global.window as any).__chatStore__ = null;
  });

  describe("Basic Merging", () => {
    it("should merge two tabs (create parent-child relationship)", () => {
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
      expect(child?.position).toBe("right");
    });

    it("should hide child tabs from visible tabs", () => {
      const parent = useTabStore.getState().createTab("chat", "chat-1", "Chat");
      const child = useTabStore
        .getState()
        .createTab("document", "doc-1", "Document");

      expect(useTabStore.getState().getVisibleTabs().length).toBe(2);

      useTabStore.getState().addChild(parent, child, "right");

      expect(useTabStore.getState().getVisibleTabs().length).toBe(1);
      expect(useTabStore.getState().getVisibleTabs()[0].id).toBe(parent);
    });

    it("should support left and right child positions (but max 1 child)", () => {
      const parent = useTabStore.getState().createTab("chat", "chat-1", "Chat");
      const leftChild = useTabStore
        .getState()
        .createTab("document", "doc-1", "Left Doc");
      const rightChild = useTabStore
        .getState()
        .createTab("document", "doc-2", "Right Doc");

      // Add left child first
      useTabStore.getState().addChild(parent, leftChild, "left");
      let parentTab = useTabStore.getState().getTab(parent);
      expect(parentTab?.childTabIds.length).toBe(1);
      expect(parentTab?.childTabIds).toContain(leftChild);
      expect(useTabStore.getState().getTab(leftChild)?.position).toBe("left");

      // Add right child - should replace left child (max 1 child rule)
      useTabStore.getState().addChild(parent, rightChild, "right");
      parentTab = useTabStore.getState().getTab(parent);
      expect(parentTab?.childTabIds.length).toBe(1);
      expect(parentTab?.childTabIds).toContain(rightChild);
      expect(parentTab?.childTabIds).not.toContain(leftChild);
      expect(useTabStore.getState().getTab(leftChild)).toBeUndefined();
      expect(useTabStore.getState().getTab(rightChild)?.position).toBe("right");
    });
  });

  describe("Child Replacement (The Important One)", () => {
    it("should replace existing child when adding new child to same position", () => {
      const parent = useTabStore.getState().createTab("chat", "chat-1", "Chat");
      const child1 = useTabStore
        .getState()
        .createTab("document", "doc-1", "Doc 1");
      const child2 = useTabStore
        .getState()
        .createTab("document", "doc-2", "Doc 2");

      // Add first child to right
      useTabStore.getState().addChild(parent, child1, "right");

      // Get initial state - now we should have parent + child1 (child2 is standalone)
      let parentTab = useTabStore.getState().getTab(parent);
      expect(parentTab?.childTabIds).toContain(child1);
      expect(useTabStore.getState().tabs.length).toBe(3); // parent + child1 + child2

      // Add second child to same position (right) - should replace first
      useTabStore.getState().addChild(parent, child2, "right");

      // Check final state
      parentTab = useTabStore.getState().getTab(parent);

      // Parent should only have child2 now
      expect(parentTab?.childTabIds).toContain(child2);
      expect(parentTab?.childTabIds).not.toContain(child1);

      // Child1 should be REMOVED from tabs, not promoted to standalone
      const child1After = useTabStore.getState().getTab(child1);
      expect(child1After).toBeUndefined();

      // Should only have 2 tabs now (parent + child2)
      expect(useTabStore.getState().tabs.length).toBe(2);
    });

    it("should handle replacement on left position", () => {
      const parent = useTabStore.getState().createTab("chat", "chat-1", "Chat");
      const child1 = useTabStore
        .getState()
        .createTab("document", "doc-1", "Doc 1");
      const child2 = useTabStore
        .getState()
        .createTab("document", "doc-2", "Doc 2");

      // Add to left
      useTabStore.getState().addChild(parent, child1, "left");

      // Replace on left
      useTabStore.getState().addChild(parent, child2, "left");

      const parentTab = useTabStore.getState().getTab(parent);
      expect(parentTab?.childTabIds).toContain(child2);
      expect(parentTab?.childTabIds).not.toContain(child1);
      expect(useTabStore.getState().getTab(child1)).toBeUndefined();
      expect(useTabStore.getState().tabs.length).toBe(2);
    });

    it("should enforce max 1 child (2 panes total)", () => {
      const parent = useTabStore.getState().createTab("chat", "chat-1", "Chat");
      const child1 = useTabStore
        .getState()
        .createTab("document", "doc-1", "Doc 1");
      const child2 = useTabStore
        .getState()
        .createTab("document", "doc-2", "Doc 2");

      // Add first child
      useTabStore.getState().addChild(parent, child1, "left");
      let parentTab = useTabStore.getState().getTab(parent);
      expect(parentTab?.childTabIds.length).toBe(1);

      // Add second child - should replace first
      useTabStore.getState().addChild(parent, child2, "right");
      parentTab = useTabStore.getState().getTab(parent);
      expect(parentTab?.childTabIds.length).toBe(1);
      expect(parentTab?.childTabIds).toContain(child2);
      expect(parentTab?.childTabIds).not.toContain(child1);

      // Only 2 tabs total (parent + 1 child)
      expect(useTabStore.getState().tabs.length).toBe(2);
    });

    it("should enforce max 1 child when adding multiple children", () => {
      const parent = useTabStore.getState().createTab("chat", "chat-1", "Chat");
      const child1 = useTabStore
        .getState()
        .createTab("document", "doc-1", "Child 1");
      const child2 = useTabStore
        .getState()
        .createTab("document", "doc-2", "Child 2");
      const child3 = useTabStore
        .getState()
        .createTab("document", "doc-3", "Child 3");

      // We now have 4 tabs: parent, child1, child2, child3 (all standalone)
      expect(useTabStore.getState().tabs.length).toBe(4);

      // Add first child
      useTabStore.getState().addChild(parent, child1, "left");
      expect(useTabStore.getState().tabs.length).toBe(4); // parent, child1, child2 (standalone), child3 (standalone)

      // Add second child - replaces first
      useTabStore.getState().addChild(parent, child2, "right");
      expect(useTabStore.getState().tabs.length).toBe(3); // parent, child2, child3 (child1 removed)
      expect(useTabStore.getState().getTab(child1)).toBeUndefined();

      // Add third child - replaces second
      useTabStore.getState().addChild(parent, child3, "left");

      const parentTab = useTabStore.getState().getTab(parent);

      // Should only have 1 child
      expect(parentTab?.childTabIds.length).toBe(1);
      expect(parentTab?.childTabIds).toContain(child3);
      expect(parentTab?.childTabIds).not.toContain(child1);
      expect(parentTab?.childTabIds).not.toContain(child2);

      // child1 and child2 should be removed
      expect(useTabStore.getState().getTab(child1)).toBeUndefined();
      expect(useTabStore.getState().getTab(child2)).toBeUndefined();
      expect(useTabStore.getState().getTab(child3)).toBeDefined();

      // Should have 2 tabs (parent + child3)
      expect(useTabStore.getState().tabs.length).toBe(2);
    });
  });

  describe("Unmerging", () => {
    it("should unmerge tab (promote child to standalone)", () => {
      const parent = useTabStore.getState().createTab("chat", "chat-1", "Chat");
      const child = useTabStore
        .getState()
        .createTab("document", "doc-1", "Document");

      useTabStore.getState().addChild(parent, child, "right");
      useTabStore.getState().promoteToStandalone(child);

      const childTab = useTabStore.getState().getTab(child);
      const parentTab = useTabStore.getState().getTab(parent);

      expect(childTab?.parentTabId).toBeNull();
      expect(childTab?.displayMode).toBe("standalone");
      expect(childTab?.position).toBeUndefined();
      expect(parentTab?.childTabIds).not.toContain(child);
      expect(useTabStore.getState().getVisibleTabs().length).toBe(2);
    });

    it("should handle double-click unmerge (simulated)", () => {
      const parent = useTabStore.getState().createTab("chat", "chat-1", "Chat");
      const child = useTabStore
        .getState()
        .createTab("document", "doc-1", "Document");

      useTabStore.getState().addChild(parent, child, "right");

      // Simulate double-click on merged tab
      useTabStore.getState().promoteToStandalone(child);

      expect(useTabStore.getState().getTab(child)?.parentTabId).toBeNull();
      expect(useTabStore.getState().getVisibleTabs().length).toBe(2);
    });
  });

  describe("Parent Tab Closing", () => {
    it("should close children when parent is closed", () => {
      const parent = useTabStore.getState().createTab("chat", "chat-1", "Chat");
      const child = useTabStore
        .getState()
        .createTab("document", "doc-1", "Document");

      useTabStore.getState().addChild(parent, child, "right");
      useTabStore.getState().closeTab(parent);

      // Both parent and child should be removed
      expect(useTabStore.getState().getTab(parent)).toBeUndefined();
      expect(useTabStore.getState().getTab(child)).toBeUndefined();
      expect(useTabStore.getState().tabs.length).toBe(0);
    });

    it("should close child when parent is closed (max 1 child)", () => {
      const parent = useTabStore.getState().createTab("chat", "chat-1", "Chat");
      const child = useTabStore
        .getState()
        .createTab("document", "doc-1", "Document");

      useTabStore.getState().addChild(parent, child, "right");
      expect(useTabStore.getState().tabs.length).toBe(2);

      useTabStore.getState().closeTab(parent);

      // Both parent and child should be removed
      expect(useTabStore.getState().getTab(parent)).toBeUndefined();
      expect(useTabStore.getState().getTab(child)).toBeUndefined();
      expect(useTabStore.getState().tabs.length).toBe(0);
    });
  });

  describe("Edge Cases", () => {
    it("should not allow a tab to be its own child", () => {
      const tab = useTabStore.getState().createTab("chat", "chat-1", "Chat");

      // Try to add tab as its own child - should be prevented
      useTabStore.getState().addChild(tab, tab, "right");

      const tabData = useTabStore.getState().getTab(tab);
      expect(tabData?.parentTabId).toBeNull();
      expect(tabData?.childTabIds).toEqual([]);
    });

    it("should handle closing child tab directly", () => {
      const parent = useTabStore.getState().createTab("chat", "chat-1", "Chat");
      const child = useTabStore
        .getState()
        .createTab("document", "doc-1", "Document");

      useTabStore.getState().addChild(parent, child, "right");
      useTabStore.getState().closeTab(child);

      const parentTab = useTabStore.getState().getTab(parent);

      // Parent should exist and have no children
      expect(parentTab).toBeDefined();
      expect(parentTab?.childTabIds.length).toBe(0);
      expect(parentTab?.displayMode).toBe("standalone");

      // Child should be removed
      expect(useTabStore.getState().getTab(child)).toBeUndefined();
      expect(useTabStore.getState().tabs.length).toBe(1);
    });

    it("should handle rapid merge/unmerge operations", () => {
      const parent = useTabStore.getState().createTab("chat", "chat-1", "Chat");
      const child = useTabStore
        .getState()
        .createTab("document", "doc-1", "Document");

      // Merge
      useTabStore.getState().addChild(parent, child, "right");
      expect(useTabStore.getState().getTab(parent)?.childTabIds).toContain(
        child,
      );

      // Unmerge
      useTabStore.getState().promoteToStandalone(child);
      expect(useTabStore.getState().getTab(child)?.parentTabId).toBeNull();

      // Merge again
      useTabStore.getState().addChild(parent, child, "left");
      expect(useTabStore.getState().getTab(parent)?.childTabIds).toContain(
        child,
      );
      expect(useTabStore.getState().getTab(child)?.position).toBe("left");

      // Unmerge again
      useTabStore.getState().promoteToStandalone(child);
      expect(useTabStore.getState().getTab(child)?.parentTabId).toBeNull();
    });

    it("should clean up orphaned references when tabs are closed", () => {
      const parent = useTabStore.getState().createTab("chat", "chat-1", "Chat");
      const child1 = useTabStore
        .getState()
        .createTab("document", "doc-1", "Doc 1");
      const child2 = useTabStore
        .getState()
        .createTab("document", "doc-2", "Doc 2");

      useTabStore.getState().addChild(parent, child1, "right");

      // Replace child1 with child2 (child1 should be removed)
      useTabStore.getState().addChild(parent, child2, "right");

      // Verify child1 is completely gone
      expect(useTabStore.getState().getTab(child1)).toBeUndefined();
      expect(
        useTabStore.getState().tabs.find((t) => t.id === child1),
      ).toBeUndefined();

      // Close parent (closes all children too)
      useTabStore.getState().closeTab(parent);

      // All should be removed
      expect(useTabStore.getState().tabs.length).toBe(0);
      expect(useTabStore.getState().getTab(child2)).toBeUndefined();
    });

    it("should allow chat to be child (no auto-swap)", () => {
      // Create a document tab
      const doc = useTabStore
        .getState()
        .createTab("document", "doc-1", "Document");

      // Create a chat and merge it as a child of the document
      const chat = useTabStore.getState().createTab("chat", "chat-1", "Chat");
      useTabStore.getState().addChild(doc, chat, "right");

      // Chat should be child, doc should be parent (no auto-swap)
      const chatTab = useTabStore.getState().getTab(chat);
      const docTab = useTabStore.getState().getTab(doc);

      expect(docTab?.displayMode).toBe("parent");
      expect(docTab?.childTabIds).toContain(chat);
      expect(chatTab?.displayMode).toBe("child");
      expect(chatTab?.parentTabId).toBe(doc);
      expect(chatTab?.position).toBe("right");
    });
  });

  describe("Creator Stays Logic", () => {
    it("should keep chat and replace other pane when chat creates artifact (chat is parent)", () => {
      const chat = useTabStore.getState().createTab("chat", "chat-1", "Chat");
      const doc = useTabStore
        .getState()
        .createTab("document", "doc-1", "Document");

      // Merge: chat parent, doc child
      useTabStore.getState().addChild(chat, doc, "right");

      // Chat creates artifact
      const artifact = useTabStore
        .getState()
        .createTab("document", "artifact-1", "Artifact");
      useTabStore.getState().createArtifactFromChat(chat, artifact);

      // Chat should stay as parent, artifact should replace doc
      const chatTab = useTabStore.getState().getTab(chat);
      expect(chatTab?.displayMode).toBe("parent");
      expect(chatTab?.childTabIds).toContain(artifact);
      expect(chatTab?.childTabIds).not.toContain(doc);

      // Doc should be removed
      expect(useTabStore.getState().getTab(doc)).toBeUndefined();

      // Only 2 tabs total
      expect(useTabStore.getState().tabs.length).toBe(2);
    });

    it("should keep chat in same position when replacing parent with artifact", () => {
      const doc = useTabStore
        .getState()
        .createTab("document", "doc-1", "Document");
      const chat = useTabStore.getState().createTab("chat", "chat-1", "Chat");

      // Merge: doc parent, chat child on right
      useTabStore.getState().addChild(doc, chat, "right");
      expect(useTabStore.getState().getTab(chat)?.position).toBe("right");

      // Chat creates artifact
      const artifact = useTabStore
        .getState()
        .createTab("document", "artifact-1", "Artifact");
      useTabStore.getState().createArtifactFromChat(chat, artifact);

      // Artifact should become parent (replaced doc)
      const artifactTab = useTabStore.getState().getTab(artifact);
      expect(artifactTab?.displayMode).toBe("parent");
      expect(artifactTab?.parentTabId).toBeNull();

      // Chat should stay as child in SAME position (right)
      const chatTab = useTabStore.getState().getTab(chat);
      expect(chatTab?.displayMode).toBe("child");
      expect(chatTab?.parentTabId).toBe(artifact);
      expect(chatTab?.position).toBe("right"); // Stayed in same position!

      // Doc should be removed
      expect(useTabStore.getState().getTab(doc)).toBeUndefined();

      // Only 2 tabs total
      expect(useTabStore.getState().tabs.length).toBe(2);
    });

    it("should add artifact when chat is standalone", () => {
      const chat = useTabStore.getState().createTab("chat", "chat-1", "Chat");

      // Chat creates artifact
      const artifact = useTabStore
        .getState()
        .createTab("document", "artifact-1", "Artifact");
      useTabStore.getState().createArtifactFromChat(chat, artifact);

      // Chat should become parent, artifact should be child
      const chatTab = useTabStore.getState().getTab(chat);
      expect(chatTab?.displayMode).toBe("parent");
      expect(chatTab?.childTabIds).toContain(artifact);

      const artifactTab = useTabStore.getState().getTab(artifact);
      expect(artifactTab?.parentTabId).toBe(chat);
      expect(artifactTab?.position).toBe("right"); // default position

      expect(useTabStore.getState().tabs.length).toBe(2);
    });

    it("should replace previous artifact when chat creates second artifact", () => {
      const chat = useTabStore.getState().createTab("chat", "chat-1", "Chat");
      const artifact1 = useTabStore
        .getState()
        .createTab("document", "artifact-1", "Artifact 1");

      // Chat creates first artifact
      useTabStore.getState().createArtifactFromChat(chat, artifact1);
      expect(useTabStore.getState().tabs.length).toBe(2);

      // Chat creates second artifact
      const artifact2 = useTabStore
        .getState()
        .createTab("document", "artifact-2", "Artifact 2");
      useTabStore.getState().createArtifactFromChat(chat, artifact2);

      // Only artifact2 should exist, artifact1 should be removed
      const chatTab = useTabStore.getState().getTab(chat);
      expect(chatTab?.childTabIds).toContain(artifact2);
      expect(chatTab?.childTabIds).not.toContain(artifact1);
      expect(useTabStore.getState().getTab(artifact1)).toBeUndefined();
      expect(useTabStore.getState().tabs.length).toBe(2);
    });
  });

  describe("Workflow Scenarios", () => {
    it("should handle: Chat creates Doc1, then creates Doc2 (replacing Doc1)", () => {
      // User has a chat
      const chat = useTabStore.getState().createTab("chat", "chat-1", "Chat");

      // Agent creates first document
      const doc1 = useTabStore
        .getState()
        .createTab("document", "doc-1", "Document v1");
      useTabStore.getState().addChild(chat, doc1, "right");

      expect(useTabStore.getState().tabs.length).toBe(2);
      expect(useTabStore.getState().getVisibleTabs().length).toBe(1);

      // Agent creates second document (replaces first)
      const doc2 = useTabStore
        .getState()
        .createTab("document", "doc-2", "Document v2");
      useTabStore.getState().addChild(chat, doc2, "right");

      // doc1 should be removed, not orphaned
      expect(useTabStore.getState().tabs.length).toBe(2); // chat + doc2
      expect(useTabStore.getState().getTab(doc1)).toBeUndefined();
      expect(useTabStore.getState().getTab(doc2)).toBeDefined();
      expect(useTabStore.getState().getTab(chat)?.childTabIds).toContain(doc2);
      expect(useTabStore.getState().getVisibleTabs().length).toBe(1);
    });

    it("should handle: User unmerges doc, then agent creates new doc", () => {
      const chat = useTabStore.getState().createTab("chat", "chat-1", "Chat");
      const doc1 = useTabStore
        .getState()
        .createTab("document", "doc-1", "Doc 1");
      useTabStore.getState().addChild(chat, doc1, "right");

      // User unmerges
      useTabStore.getState().promoteToStandalone(doc1);
      expect(useTabStore.getState().getVisibleTabs().length).toBe(2);

      // Agent creates new doc
      const doc2 = useTabStore
        .getState()
        .createTab("document", "doc-2", "Doc 2");
      useTabStore.getState().addChild(chat, doc2, "right");

      // Should have chat merged with doc2, and doc1 standalone
      expect(useTabStore.getState().tabs.length).toBe(3);
      expect(useTabStore.getState().getVisibleTabs().length).toBe(2); // chat (with doc2 child) and doc1
      expect(useTabStore.getState().getTab(chat)?.childTabIds).toContain(doc2);
      expect(useTabStore.getState().getTab(doc1)?.parentTabId).toBeNull();
    });
  });
});
