/**
 * Ensure the UI always has an active chat tab (empty temp chat if needed).
 */

import { useChatStore, defaultChatState } from "../stores/chatStore";
import { useTabStore } from "../stores/tabStore";

/** Prevents concurrent empty-chat creation during workspace reload races. */
let pendingDefaultChatTabId: string | null = null;

function createTempChatId(): string {
  return `temp-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/** Test hook — reset in-flight default chat state between unit tests. */
export function resetDefaultChatTabGuardForTests(): void {
  pendingDefaultChatTabId = null;
}

function createEmptyChatTab(): string {
  const tempId = createTempChatId();
  const { chatStates } = useChatStore.getState();
  const newChatStates = new Map(chatStates);
  newChatStates.set(tempId, { ...defaultChatState });
  useChatStore.setState({ chatStates: newChatStates });

  const { createTab, switchToTab } = useTabStore.getState();
  const tabId = createTab("chat", tempId, "New Chat");
  switchToTab(tabId);
  return tabId;
}

/** Switch to the standalone tab of `type`, or open one. */
function switchToSingleton(type: "focus" | "memory", entityId: string, title: string): string {
  const { tabs, switchToTab, createTab } = useTabStore.getState();
  const existing = [...tabs]
    .reverse()
    .find((tab) => tab.type === type && tab.displayMode === "standalone");
  if (existing) {
    switchToTab(existing.id);
    return existing.id;
  }
  const tabId = createTab(type, entityId, title);
  switchToTab(tabId);
  return tabId;
}

/** Focus — the agent's page (today's brief, your three, tasks). Opened from the rail agent. */
export function switchToFocusTab(): string {
  return switchToSingleton("focus", "focus", "Focus");
}

/** Memory — what the agent knows (people, projects, context). Its own rail destination. */
export function switchToMemoryTab(): string {
  return switchToSingleton("memory", "wiki", "Memory");
}

/** @deprecated Home is now Focus. */
export const switchToHomeTab = switchToFocusTab;

/** Returns the active tab id after ensuring Focus exists when none is selected. */
export function ensureDefaultHomeTab(): string {
  const { activeTabId, getTab, switchToTab } = useTabStore.getState();

  if (activeTabId && getTab(activeTabId)) {
    return activeTabId;
  }

  return switchToFocusTab();
}

/** Switch to an existing chat tab, or open a new empty one. */
export function switchToChatTab(): string {
  const { tabs, switchToTab } = useTabStore.getState();
  const existingChat = [...tabs]
    .reverse()
    .find((tab) => tab.type === "chat" && tab.displayMode === "standalone");
  if (existingChat) {
    switchToTab(existingChat.id);
    return existingChat.id;
  }
  return createEmptyChatTab();
}

/** Returns the active tab id after ensuring some tab exists (chat if none). */
export function ensureDefaultChatTab(): string {
  const { activeTabId, getTab, switchToTab } = useTabStore.getState();

  if (activeTabId && getTab(activeTabId)) {
    pendingDefaultChatTabId = null;
    return activeTabId;
  }

  if (pendingDefaultChatTabId) {
    const pendingTab = getTab(pendingDefaultChatTabId);
    if (pendingTab) {
      switchToTab(pendingDefaultChatTabId);
      return pendingDefaultChatTabId;
    }
    pendingDefaultChatTabId = null;
  }

  const tabId = switchToChatTab();
  pendingDefaultChatTabId = tabId;
  return tabId;
}
