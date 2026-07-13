/**
 * Resolve UI focus context to send with agent:stream / chat:inspect-context.
 * Kept in renderer — gateway enriches with file list + recent edits.
 */

import type { UiAgentFocusContext } from "../../src/core/types/agentFocus";
import type { Tab } from "../types/tabs";
import { useTabStore } from "../stores/tabStore";
import { useJobNavigationStore } from "../stores/jobNavigationStore";

function isAppTab(tab: Tab | undefined): tab is Tab & { type: "app" } {
  return tab?.type === "app";
}

function findAppTabBesideChat(
  state: ReturnType<typeof useTabStore.getState>,
  chatTab: Tab,
): Tab | null {
  if (chatTab.displayMode === "parent" && chatTab.childTabIds.length > 0) {
    for (const childId of chatTab.childTabIds) {
      const child = state.getTab(childId);
      if (isAppTab(child)) return child;
    }
  }

  if (chatTab.parentTabId) {
    const parent = state.getTab(chatTab.parentTabId);
    if (parent?.childTabIds) {
      for (const childId of parent.childTabIds) {
        if (childId === chatTab.id) continue;
        const child = state.getTab(childId);
        if (isAppTab(child)) return child;
      }
    }
  }

  const left = state.activeLeftTab
    ? state.getTab(state.activeLeftTab)
    : undefined;
  const right = state.activeRightTab
    ? state.getTab(state.activeRightTab)
    : undefined;

  if (
    left?.type === "chat" &&
    left.entityId === chatTab.entityId &&
    isAppTab(right)
  ) {
    return right;
  }
  if (
    right?.type === "chat" &&
    right.entityId === chatTab.entityId &&
    isAppTab(left)
  ) {
    return left;
  }

  return null;
}

function findActiveAppTab(
  state: ReturnType<typeof useTabStore.getState>,
): Tab | null {
  const candidates: Array<string | null> = [
    state.activeTabId,
    state.activeLeftTab,
    state.activeRightTab,
  ];

  for (const tabId of candidates) {
    if (!tabId) continue;
    const tab = state.getTab(tabId);
    if (isAppTab(tab)) return tab;
  }

  return null;
}

function findAnyOpenAppTab(
  state: ReturnType<typeof useTabStore.getState>,
): Tab | null {
  for (const tab of state.tabs) {
    if (tab.type === "app" && tab.displayMode !== "child") {
      return tab;
    }
  }
  return null;
}

/** Resolve focus for a chat message. */
export function resolveAgentFocusContext(
  _chatId: string,
): UiAgentFocusContext | undefined {
  const state = useTabStore.getState();
  const chatTab = state.getTab(`chat-${_chatId}`);

  const appTab =
    (chatTab ? findAppTabBesideChat(state, chatTab) : null) ??
    findActiveAppTab(state) ??
    findAnyOpenAppTab(state);

  const { selectedJobId, selectedJobName } = useJobNavigationStore.getState();

  if (!appTab && !selectedJobId) {
    return undefined;
  }

  const focus: UiAgentFocusContext = {};

  if (appTab) {
    focus.activeApp = {
      appId: appTab.entityId,
      title: appTab.title,
    };
  }

  if (selectedJobId && selectedJobName) {
    focus.activeJob = {
      jobId: selectedJobId,
      name: selectedJobName,
    };
  }

  return focus;
}
