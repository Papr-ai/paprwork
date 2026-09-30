import { beforeEach, describe, expect, it } from "vitest";
import { useTabStore } from "../ui/stores/tabStore";
import {
  ensureWorkspaceLandingTab,
  needsWorkspaceLandingTab,
} from "../ui/lib/ensureWorkspaceLandingTab";

describe("ensureWorkspaceLandingTab", () => {
  beforeEach(() => {
    useTabStore.setState({
      tabs: [],
      activeTabId: null,
      activeLeftTab: null,
      activeRightTab: null,
      isSplitView: false,
      history: [],
      historyIndex: -1,
    });
  });

  it("opens a chat when tabs are empty (no in-workspace Getting Started)", () => {
    const tabId = ensureWorkspaceLandingTab();
    const { tabs, activeTabId } = useTabStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.type).toBe("chat");
    expect(activeTabId).toBe(tabId);
  });

  it("needsWorkspaceLandingTab is false when an active tab exists", () => {
    ensureWorkspaceLandingTab();
    expect(needsWorkspaceLandingTab()).toBe(false);
  });

  it("needsWorkspaceLandingTab is true when tabs were cleared", () => {
    expect(needsWorkspaceLandingTab()).toBe(true);
  });
});
