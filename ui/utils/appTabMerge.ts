import { useChatStore } from "../stores/chatStore";
import { useTabStore } from "../stores/tabStore";

/** Chat tab id (e.g. chat-abc) for an app tab merged as split-view child of chat. */
export function findPairedChatTabIdForAppTab(appTabId: string): string | null {
  const appTab = useTabStore.getState().getTab(appTabId);
  if (!appTab?.parentTabId) return null;

  const parent = useTabStore.getState().getTab(appTab.parentTabId);
  if (parent?.type === "chat") return parent.id;

  return null;
}

export function chatEntityIdFromTabId(chatTabId: string): string {
  return chatTabId.startsWith("chat-") ? chatTabId.slice(5) : chatTabId;
}

export function isAppTabMergedWithChat(
  chatTabId: string,
  appTabId: string,
): boolean {
  const { getTab } = useTabStore.getState();
  const chatTab = getTab(chatTabId);
  const appTab = getTab(appTabId);
  if (!chatTab || !appTab) return false;

  if (
    appTab.parentTabId === chatTabId &&
    chatTab.childTabIds.includes(appTabId)
  ) {
    return true;
  }

  if (
    chatTab.parentTabId === appTabId &&
    appTab.childTabIds.includes(chatTabId)
  ) {
    return true;
  }

  return false;
}

export function isPlatformTabMergedWithChat(
  chatTabId: string,
  platformTabId: string,
): boolean {
  const { getTab } = useTabStore.getState();
  const chatTab = getTab(chatTabId);
  const platformTab = getTab(platformTabId);
  if (!chatTab || !platformTab) return false;

  if (
    platformTab.parentTabId === chatTabId &&
    chatTab.childTabIds.includes(platformTabId)
  ) {
    return true;
  }

  if (
    chatTab.parentTabId === platformTabId &&
    platformTab.childTabIds.includes(chatTabId)
  ) {
    return true;
  }

  return false;
}

/** Prefer the chat tab that is actively streaming (agent working). */
export function resolveChatTabForPlatformMerge(): string | undefined {
  const { chatStates } = useChatStore.getState();
  for (const [chatId, state] of chatStates) {
    if (!state.isSending) {
      continue;
    }
    const tabId = `chat-${chatId}`;
    if (useTabStore.getState().getTab(tabId)) {
      return tabId;
    }
  }

  const { tabs, activeTabId, getTab } = useTabStore.getState();

  for (const tab of tabs) {
    if (tab.type === "chat" && tab.metadata?.isStreaming === true) {
      return tab.id;
    }
  }

  if (activeTabId?.startsWith("chat-")) {
    return activeTabId;
  }

  const active = activeTabId ? getTab(activeTabId) : undefined;
  if (!active) {
    return undefined;
  }

  if (active.type === "chat") {
    return active.id;
  }

  if (active.displayMode === "parent") {
    for (const childId of active.childTabIds) {
      const child = getTab(childId);
      if (child?.type === "chat") {
        return child.id;
      }
    }
  }

  if (active.displayMode === "child" && active.parentTabId) {
    const parent = getTab(active.parentTabId);
    if (parent?.type === "chat") {
      return parent.id;
    }
  }

  return undefined;
}

/** True while the chat building this app is still sending / streaming. */
export function isPairedChatActivelyStreaming(appId: string): boolean {
  const chatTabId = findPairedChatTabIdForAppTab(`app-${appId}`);
  if (!chatTabId) return false;

  const chatTab = useTabStore.getState().getTab(chatTabId);
  if (chatTab?.metadata?.isStreaming === true) return true;

  const chatId = chatEntityIdFromTabId(chatTabId);
  const chatState = useChatStore.getState().chatStates.get(chatId);
  if (!chatState) return false;

  return (
    chatState.isSending ||
    chatState.isStreaming ||
    chatState.messages.some((message) => message.isStreaming)
  );
}

/** User is focused on the app pane in a chat+app split view. */
export function isUserViewingAppPane(appTabId: string): boolean {
  const { activeRightTab } = useTabStore.getState();
  return activeRightTab === appTabId;
}
