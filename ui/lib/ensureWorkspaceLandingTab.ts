/**
 * Default landing tab when a workspace has no restored tabs (empty org / first login).
 * Prefer onboarding for new users; otherwise open Profile in Settings.
 */

import { useTabStore } from "../stores/tabStore";
import { shouldShowOnboarding } from "../utils/onboardingState";
import { ensureSettingsTab } from "./ensureSettingsTab";

export function ensureGettingStartedTab(): string {
  const { tabs, createTab, switchToTab } = useTabStore.getState();
  const existing = tabs.find((tab) => tab.type === "getting-started");
  if (existing) {
    switchToTab(existing.id);
    return existing.id;
  }
  const tabId = createTab(
    "getting-started",
    "getting-started",
    "Getting Started",
  );
  switchToTab(tabId);
  return tabId;
}

export function needsWorkspaceLandingTab(): boolean {
  const { tabs, activeTabId, getTab } = useTabStore.getState();
  if (activeTabId && getTab(activeTabId)) {
    return false;
  }
  return tabs.length === 0;
}

/** Open onboarding or Profile when the workspace tab bar is empty. */
export function ensureWorkspaceLandingTab(): string {
  const { tabs, activeTabId, getTab, switchToTab } = useTabStore.getState();

  if (activeTabId && getTab(activeTabId)) {
    return activeTabId;
  }

  if (tabs.length > 0) {
    const fallback = tabs[tabs.length - 1];
    switchToTab(fallback.id);
    return fallback.id;
  }

  if (shouldShowOnboarding()) {
    return ensureGettingStartedTab();
  }

  return ensureSettingsTab({ section: "profile" });
}
