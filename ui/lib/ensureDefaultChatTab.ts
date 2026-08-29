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

/** Switch to an existing Home (memory) tab, or open a new one. */
export function switchToHomeTab(): string {
  const { tabs, switchToTab, createTab, updateTabTitle } =
    useTabStore.getState();
  const existingHome = [...tabs]
    .reverse()
    .find((tab) => tab.type === "memory" && tab.displayMode === "standalone");
  if (existingHome) {
    if (existingHome.title === "Memory") {
      updateTabTitle(existingHome.id, "Home");
    }
    switchToTab(existingHome.id);
    return existingHome.id;
  }
  const tabId = createTab("memory", "memory", "Home");
  switchToTab(tabId);
  return tabId;
}

/** Returns the active tab id after ensuring Home exists when none is selected. */
export function ensureDefaultHomeTab(): string {
  const { activeTabId, getTab, switchToTab } = useTabStore.getState();

  if (activeTabId && getTab(activeTabId)) {
    return activeTabId;
  }

  return switchToHomeTab();
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
