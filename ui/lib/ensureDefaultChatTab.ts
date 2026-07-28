/**
 * Ensure the UI always has an active chat tab (empty temp chat if needed).
 */

import { useChatStore, defaultChatState } from "../stores/chatStore";
import { useTabStore } from "../stores/tabStore";

function createTempChatId(): string {
  return `temp-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
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
  const { activeTabId, getTab } = useTabStore.getState();

  if (activeTabId && getTab(activeTabId)) {
    return activeTabId;
  }

  return switchToChatTab();
}
