/**
 * Default landing tab when a workspace has no restored tabs (empty org / first
 * login). Onboarding now happens in the gated AuthFlow before the workspace
 * exists, so there is no in-workspace "Getting Started" tab — land on a chat.
 */

import { useTabStore } from "../stores/tabStore";
import { ensureDefaultChatTab } from "./ensureDefaultChatTab";

export function needsWorkspaceLandingTab(): boolean {
  const { tabs, activeTabId, getTab } = useTabStore.getState();
  if (activeTabId && getTab(activeTabId)) {
    return false;
  }
  return tabs.length === 0;
}

/** Open a chat when the workspace tab bar is empty. */
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

  return ensureDefaultChatTab();
}
