import { describe, it, expect, beforeEach } from "vitest";
import { useTabStore } from "../../stores/tabStore";

describe("TabStore", () => {
  beforeEach(() => {
    // Reset store before each test
    useTabStore.setState({
      tabs: [],
      activeTabId: null,
      splitRatio: 0.5,
      isSplitView: false,
      activeLeftTab: null,
      activeRightTab: null,
    });

    // Setup global window for empty chat detection
    if (!global.window) {
      (global as any).window = {};
    }
    (global.window as any).__chatStore__ = null;
  });

  describe("Tab Creation", () => {
    it("should create a new tab", () => {
      const tabId = useTabStore
        .getState()
        .createTab("chat", "chat-1", "Test Chat");

      expect(tabId).toBe("chat-chat-1");
      expect(useTabStore.getState().tabs.length).toBe(1);
      expect(useTabStore.getState().tabs[0].id).toBe("chat-chat-1");
      expect(useTabStore.getState().tabs[0].title).toBe("Test Chat");
      expect(useTabStore.getState().tabs[0].type).toBe("chat");
      expect(useTabStore.getState().tabs[0].entityId).toBe("chat-1");
    });

    it("should not create duplicate tabs", () => {
      const tabId1 = useTabStore
        .getState()
        .createTab("chat", "chat-1", "Test Chat");
      const tabId2 = useTabStore
        .getState()
        .createTab("chat", "chat-1", "Test Chat");

      expect(tabId1).toBe(tabId2);
      expect(useTabStore.getState().tabs.length).toBe(1);
    });

    it("should switch to existing tab instead of creating duplicate", () => {
      // Create first tab
      const tabId1 = useTabStore
        .getState()
        .createTab("chat", "chat-1", "Chat 1");
      expect(useTabStore.getState().activeTabId).toBe("chat-chat-1");

      // Create second tab
      const tabId2 = useTabStore
        .getState()
        .createTab("chat", "chat-2", "Chat 2");
      expect(useTabStore.getState().activeTabId).toBe("chat-chat-2");

      // Try to create first tab again
      const tabId3 = useTabStore
        .getState()
        .createTab("chat", "chat-1", "Chat 1");

      // Should return same ID and switch to it
      expect(tabId3).toBe(tabId1);
      expect(useTabStore.getState().activeTabId).toBe("chat-chat-1");
      expect(useTabStore.getState().tabs.length).toBe(2);
    });

    it("should create tabs with different types", () => {
      useTabStore.getState().createTab("chat", "chat-1", "Chat");
      useTabStore.getState().createTab("document", "doc-1", "Document");
      useTabStore.getState().createTab("settings", "settings", "Settings");

      expect(useTabStore.getState().tabs.length).toBe(3);
      expect(useTabStore.getState().tabs[0].type).toBe("chat");
      expect(useTabStore.getState().tabs[1].type).toBe("document");
      expect(useTabStore.getState().tabs[2].type).toBe("settings");
    });
  });

  describe("Existing Tab Detection", () => {
    it("should detect existing artifacts tab", () => {
      // Create artifacts tab
      const tabId1 = useTabStore
        .getState()
        .createTab("document", "artifacts", "Artifacts");
      expect(useTabStore.getState().tabs.length).toBe(1);

      // Try to create again
      const tabId2 = useTabStore
        .getState()
        .createTab("document", "artifacts", "Artifacts");

      // Should return same tab
      expect(tabId2).toBe(tabId1);
      expect(useTabStore.getState().tabs.length).toBe(1);
    });

    it("should detect existing settings tab", () => {
      // Create settings tab
      const tabId1 = useTabStore
        .getState()
        .createTab("settings", "settings", "Settings");
      expect(useTabStore.getState().tabs.length).toBe(1);

      // Try to create again
      const tabId2 = useTabStore
        .getState()
        .createTab("settings", "settings", "Settings");

      // Should return same tab
      expect(tabId2).toBe(tabId1);
      expect(useTabStore.getState().tabs.length).toBe(1);
    });

    it("should detect existing chat tabs by entity ID", () => {
      // Create chat tab
      const chatId = "abc-123";
      const tabId1 = useTabStore.getState().createTab("chat", chatId, "Chat 1");
      expect(useTabStore.getState().tabs.length).toBe(1);

      // Try to create again with same chat ID
      const tabId2 = useTabStore.getState().createTab("chat", chatId, "Chat 1");

      // Should return same tab
      expect(tabId2).toBe(tabId1);
      expect(useTabStore.getState().tabs.length).toBe(1);
    });
  });

  describe("Tab Switching", () => {
    it("should switch between tabs", () => {
      const tab1 = useTabStore.getState().createTab("chat", "chat-1", "Chat 1");
      const tab2 = useTabStore.getState().createTab("chat", "chat-2", "Chat 2");

      expect(useTabStore.getState().activeTabId).toBe(tab2);

      useTabStore.getState().switchToTab(tab1);
      expect(useTabStore.getState().activeTabId).toBe(tab1);

      useTabStore.getState().switchToTab(tab2);
      expect(useTabStore.getState().activeTabId).toBe(tab2);
    });

    it("should restore pane selection from persisted activeTabId", () => {
      const tab1 = useTabStore.getState().createTab("chat", "chat-1", "Chat 1");
      useTabStore.getState().createTab("chat", "chat-2", "Chat 2");

      // Simulate older persisted state where activeTabId exists but pane fields were not restored.
      useTabStore.setState({
        activeTabId: tab1,
        activeLeftTab: null,
        activeRightTab: null,
        isSplitView: false,
      });

      useTabStore.getState().switchToTab(tab1, true);

      expect(useTabStore.getState().activeTabId).toBe(tab1);
      expect(useTabStore.getState().activeLeftTab).toBe(tab1);
      expect(useTabStore.getState().isSplitView).toBe(false);
    });
  });

  describe("Tab Closing", () => {
    it("should close tabs", () => {
      const tab1 = useTabStore.getState().createTab("chat", "chat-1", "Chat 1");
      const tab2 = useTabStore.getState().createTab("chat", "chat-2", "Chat 2");

      expect(useTabStore.getState().tabs.length).toBe(2);

      useTabStore.getState().closeTab(tab1);
      expect(useTabStore.getState().tabs.length).toBe(1);
      expect(useTabStore.getState().tabs[0].id).toBe(tab2);
    });

    it("should switch to adjacent tab when closing active tab", () => {
      const tab1 = useTabStore.getState().createTab("chat", "chat-1", "Chat 1");
      const tab2 = useTabStore.getState().createTab("chat", "chat-2", "Chat 2");
      const tab3 = useTabStore.getState().createTab("chat", "chat-3", "Chat 3");

      useTabStore.getState().switchToTab(tab2);
      expect(useTabStore.getState().activeTabId).toBe(tab2);

      useTabStore.getState().closeTab(tab2);

      // Should switch to next tab (tab3)
      expect(useTabStore.getState().activeTabId).toBe(tab3);
      expect(useTabStore.getState().tabs.length).toBe(2);
    });
  });

  describe("Parent-Child Relationships", () => {
    it("should create parent-child relationship", () => {
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

    it("should hide child tabs from visible tabs", () => {
      const parentId = useTabStore
        .getState()
        .createTab("chat", "chat-1", "Chat");
      const childId = useTabStore
        .getState()
        .createTab("document", "doc-1", "Document");

      expect(useTabStore.getState().getVisibleTabs().length).toBe(2);

      useTabStore.getState().addChild(parentId, childId, "right");

      expect(useTabStore.getState().getVisibleTabs().length).toBe(1);
      expect(useTabStore.getState().getVisibleTabs()[0].id).toBe(parentId);
    });

    it("should close children when parent is closed", () => {
      const parentId = useTabStore
        .getState()
        .createTab("chat", "chat-1", "Chat");
      const childId = useTabStore
        .getState()
        .createTab("document", "doc-1", "Document");

      useTabStore.getState().addChild(parentId, childId, "right");
      useTabStore.getState().closeTab(parentId);

      // Both should be removed
      expect(useTabStore.getState().getTab(parentId)).toBeUndefined();
      expect(useTabStore.getState().getTab(childId)).toBeUndefined();
      expect(useTabStore.getState().tabs.length).toBe(0);
    });
  });

  describe("getTab", () => {
    it("should return tab by ID", () => {
      const tabId = useTabStore
        .getState()
        .createTab("chat", "chat-1", "Test Chat");
      const tab = useTabStore.getState().getTab(tabId);

      expect(tab).toBeDefined();
      expect(tab?.id).toBe(tabId);
    });

    it("should return undefined for non-existent tab", () => {
      const tab = useTabStore.getState().getTab("non-existent");
      expect(tab).toBeUndefined();
    });
  });
});
