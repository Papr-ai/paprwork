/**
 * Navigation History Tests
 * Tests back/forward navigation through tab history
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useTabStore } from "../../stores/tabStore";

describe("Navigation History", () => {
  beforeEach(() => {
    useTabStore.setState({
      tabs: [],
      activeTabId: null,
      splitRatio: 0.5,
      isSplitView: false,
      activeLeftTab: null,
      activeRightTab: null,
      history: [],
      historyIndex: -1,
    });
  });

  describe("History Recording", () => {
    it("should record tab switches in history", () => {
      // Creating tabs automatically switches to them and records history
      const tab1 = useTabStore.getState().createTab("chat", "chat-1", "Chat 1");
      const tab2 = useTabStore
        .getState()
        .createTab("document", "doc-1", "Doc 1");
      const tab3 = useTabStore
        .getState()
        .createTab("meeting", "meet-1", "Meeting 1");

      const state = useTabStore.getState();
      expect(state.history).toEqual([tab1, tab2, tab3]);
      expect(state.historyIndex).toBe(2); // Points to tab3
    });

    it("should not record duplicate consecutive switches", () => {
      // Creating tab records it in history
      const tab1 = useTabStore.getState().createTab("chat", "chat-1", "Chat 1");

      // Switch to same tab multiple times (should not add duplicates)
      useTabStore.getState().switchToTab(tab1);
      useTabStore.getState().switchToTab(tab1);
      useTabStore.getState().switchToTab(tab1);

      const state = useTabStore.getState();
      expect(state.history).toEqual([tab1]);
      expect(state.historyIndex).toBe(0);
    });

    it("should truncate forward history when switching to new tab", () => {
      // Creating tabs records history: [tab1, tab2, tab3]
      const tab1 = useTabStore.getState().createTab("chat", "chat-1", "Chat 1");
      const tab2 = useTabStore
        .getState()
        .createTab("document", "doc-1", "Doc 1");
      const tab3 = useTabStore
        .getState()
        .createTab("meeting", "meet-1", "Meeting 1");

      // Go back to tab2 (index goes from 2 to 1)
      useTabStore.getState().goBack();
      expect(useTabStore.getState().activeTabId).toBe(tab2);
      expect(useTabStore.getState().historyIndex).toBe(1);

      // Switch to tab1 - should truncate tab3 from forward history and add tab1
      useTabStore.getState().switchToTab(tab1);

      const state = useTabStore.getState();
      expect(state.history).toEqual([tab1, tab2, tab1]); // tab3 truncated
      expect(state.historyIndex).toBe(2);
    });
  });

  describe("goBack", () => {
    it("should navigate back through history", () => {
      // Creating tabs records history: [tab1, tab2, tab3]
      const tab1 = useTabStore.getState().createTab("chat", "chat-1", "Chat 1");
      const tab2 = useTabStore
        .getState()
        .createTab("document", "doc-1", "Doc 1");
      const tab3 = useTabStore
        .getState()
        .createTab("meeting", "meet-1", "Meeting 1");

      // Go back once
      const success = useTabStore.getState().goBack();

      expect(success).toBe(true);
      expect(useTabStore.getState().activeTabId).toBe(tab2);
      expect(useTabStore.getState().historyIndex).toBe(1);

      // Go back again
      useTabStore.getState().goBack();
      expect(useTabStore.getState().activeTabId).toBe(tab1);
      expect(useTabStore.getState().historyIndex).toBe(0);
    });

    it("should return false when at beginning of history", () => {
      // Creating tab records it in history at index 0
      const tab1 = useTabStore.getState().createTab("chat", "chat-1", "Chat 1");

      // Can't go back when only one item in history
      const success = useTabStore.getState().goBack();
      expect(success).toBe(false);
      expect(useTabStore.getState().historyIndex).toBe(0);
    });

    it("should skip closed tabs and continue back", () => {
      // Creating tabs records history: [tab1, tab2, tab3]
      const tab1 = useTabStore.getState().createTab("chat", "chat-1", "Chat 1");
      const tab2 = useTabStore
        .getState()
        .createTab("document", "doc-1", "Doc 1");
      const tab3 = useTabStore
        .getState()
        .createTab("meeting", "meet-1", "Meeting 1");

      // Close tab2 (closeTab cleans history automatically)
      useTabStore.getState().closeTab(tab2);

      // Go back should go to tab1 (tab2 already removed from history)
      useTabStore.getState().goBack();
      expect(useTabStore.getState().activeTabId).toBe(tab1);
    });
  });

  describe("goForward", () => {
    it("should navigate forward through history", () => {
      // Creating tabs records history: [tab1, tab2, tab3]
      const tab1 = useTabStore.getState().createTab("chat", "chat-1", "Chat 1");
      const tab2 = useTabStore
        .getState()
        .createTab("document", "doc-1", "Doc 1");
      const tab3 = useTabStore
        .getState()
        .createTab("meeting", "meet-1", "Meeting 1");

      // Go back twice
      useTabStore.getState().goBack();
      useTabStore.getState().goBack();
      expect(useTabStore.getState().activeTabId).toBe(tab1);

      // Go forward once
      const success = useTabStore.getState().goForward();
      expect(success).toBe(true);
      expect(useTabStore.getState().activeTabId).toBe(tab2);

      // Go forward again
      useTabStore.getState().goForward();
      expect(useTabStore.getState().activeTabId).toBe(tab3);
    });

    it("should return false when at end of history", () => {
      // Creating tabs records history: [tab1, tab2]
      const tab1 = useTabStore.getState().createTab("chat", "chat-1", "Chat 1");
      const tab2 = useTabStore
        .getState()
        .createTab("document", "doc-1", "Doc 1");

      // Already at end (tab2), can't go forward
      const success = useTabStore.getState().goForward();
      expect(success).toBe(false);
    });

    it("should skip closed tabs and continue forward", () => {
      // Creating tabs records history: [tab1, tab2, tab3]
      const tab1 = useTabStore.getState().createTab("chat", "chat-1", "Chat 1");
      const tab2 = useTabStore
        .getState()
        .createTab("document", "doc-1", "Doc 1");
      const tab3 = useTabStore
        .getState()
        .createTab("meeting", "meet-1", "Meeting 1");

      // Go back twice (now at tab1)
      useTabStore.getState().goBack();
      useTabStore.getState().goBack();
      expect(useTabStore.getState().activeTabId).toBe(tab1);

      // Close tab2 (history cleaning happens automatically)
      useTabStore.getState().closeTab(tab2);

      // Go forward should skip to tab3 (tab2 already removed from history)
      useTabStore.getState().goForward();
      expect(useTabStore.getState().activeTabId).toBe(tab3);
    });
  });

  describe("canGoBack / canGoForward", () => {
    it("should correctly report ability to go back", () => {
      expect(useTabStore.getState().canGoBack()).toBe(false);

      // Creating tab1 records it in history at index 0
      const tab1 = useTabStore.getState().createTab("chat", "chat-1", "Chat 1");
      expect(useTabStore.getState().canGoBack()).toBe(false); // Only one item, can't go back

      // Creating tab2 records it at index 1
      const tab2 = useTabStore
        .getState()
        .createTab("document", "doc-1", "Doc 1");
      expect(useTabStore.getState().canGoBack()).toBe(true); // Now we can go back
    });

    it("should correctly report ability to go forward", () => {
      // Creating tabs records history: [tab1, tab2]
      const tab1 = useTabStore.getState().createTab("chat", "chat-1", "Chat 1");
      const tab2 = useTabStore
        .getState()
        .createTab("document", "doc-1", "Doc 1");

      // At end of history
      expect(useTabStore.getState().canGoForward()).toBe(false);

      // Go back
      useTabStore.getState().goBack();
      expect(useTabStore.getState().canGoForward()).toBe(true);

      // Go forward to end again
      useTabStore.getState().goForward();
      expect(useTabStore.getState().canGoForward()).toBe(false);
    });
  });

  describe("History Cleanup on Tab Close", () => {
    it("should remove closed tab from history", () => {
      // Creating tabs records history: [tab1, tab2, tab3]
      const tab1 = useTabStore.getState().createTab("chat", "chat-1", "Chat 1");
      const tab2 = useTabStore
        .getState()
        .createTab("document", "doc-1", "Doc 1");
      const tab3 = useTabStore
        .getState()
        .createTab("meeting", "meet-1", "Meeting 1");

      // Close tab2
      useTabStore.getState().closeTab(tab2);

      const state = useTabStore.getState();
      expect(state.history).toEqual([tab1, tab3]);
      expect(state.history).not.toContain(tab2);
    });

    it("should adjust history index when closed tab was before current", () => {
      // Creating tabs records history: [tab1, tab2, tab3]
      const tab1 = useTabStore.getState().createTab("chat", "chat-1", "Chat 1");
      const tab2 = useTabStore
        .getState()
        .createTab("document", "doc-1", "Doc 1");
      const tab3 = useTabStore
        .getState()
        .createTab("meeting", "meet-1", "Meeting 1");

      expect(useTabStore.getState().historyIndex).toBe(2); // At tab3

      // Close tab1 (at index 0)
      useTabStore.getState().closeTab(tab1);

      // History should be [tab2, tab3] and index should be adjusted
      const state = useTabStore.getState();
      expect(state.history).toEqual([tab2, tab3]);
      expect(state.historyIndex).toBe(1); // Adjusted from 2 to 1
    });
  });

  describe("Integration with Merged Tabs", () => {
    it("should record parent tab when switching to merged tab", () => {
      // Creating tabs records history: [chat, doc]
      const chat = useTabStore.getState().createTab("chat", "chat-1", "Chat");
      const doc = useTabStore
        .getState()
        .createTab("document", "doc-1", "Document");

      // Merge doc with chat (doc becomes child)
      useTabStore.getState().addChild(chat, doc, "right");

      // Switch back to chat
      useTabStore.getState().switchToTab(chat);

      const state = useTabStore.getState();
      expect(state.activeTabId).toBe(chat); // Should be parent
      expect(state.history).toEqual([chat, doc, chat]); // chat, doc, then back to chat
    });
  });
});
