import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTabStore } from "../ui/stores/tabStore";

vi.mock("../ui/utils/onboardingState", () => ({
  shouldShowOnboarding: vi.fn(() => true),
}));

import { shouldShowOnboarding } from "../ui/utils/onboardingState";
import {
  ensureGettingStartedTab,
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
    vi.mocked(shouldShowOnboarding).mockReturnValue(true);
  });

  it("opens Getting Started when onboarding is active and tabs are empty", () => {
    const tabId = ensureWorkspaceLandingTab();
    const { tabs, activeTabId } = useTabStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.type).toBe("getting-started");
    expect(activeTabId).toBe(tabId);
  });

  it("opens Profile when onboarding is completed and tabs are empty", () => {
    vi.mocked(shouldShowOnboarding).mockReturnValue(false);
    const tabId = ensureWorkspaceLandingTab();
    const { tabs, activeTabId } = useTabStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.type).toBe("settings");
    expect(activeTabId).toBe(tabId);
  });

  it("needsWorkspaceLandingTab is false when an active tab exists", () => {
    ensureGettingStartedTab();
    expect(needsWorkspaceLandingTab()).toBe(false);
  });

  it("needsWorkspaceLandingTab is true when tabs were cleared", () => {
    expect(needsWorkspaceLandingTab()).toBe(true);
  });
});
