/**
 * Decides whether a "New Chat" click may land on a tab that already exists.
 *
 * Reusing a blank chat keeps background flows (startup, deep links, skill
 * launches) from stacking identical empty tabs. The cost is that reuse is
 * invisible: when the candidate is already on screen, the click looks broken.
 * So a tab only qualifies while it is genuinely interchangeable with a fresh
 * one — blank, standalone, idle — and an explicit user action can opt out with
 * `forceNew`.
 */

import type { Tab } from "../types/tabs";

/** Minimal slice of the chat store this module reads (see window.__chatStore__). */
export interface ChatStoreProbe {
  getChatState?: (chatId: string) => { messages?: unknown[] } | undefined;
  getDraftMessage?: (chatId: string) => string | undefined;
}

export interface FindReusableChatTabInput {
  tabs: Tab[];
  chatStore?: ChatStoreProbe | null;
  /** Explicit user intent ("New Chat", tab-bar +, Cmd/Ctrl+T) — never reuse. */
  forceNew?: boolean;
}

/**
 * A merged tab carries another pane's context (an app on the right, an
 * artifact, a split view). Handing that back as "your new chat" silently
 * inherits context the user did not ask for, and switching to it is a no-op
 * when it is already the active pair — the reported "New Chat does nothing".
 */
export function isMergedTab(tab: Tab): boolean {
  return (
    Boolean(tab.parentTabId) ||
    tab.displayMode !== "standalone" ||
    tab.childTabIds.length > 0
  );
}

/** Blank means: no messages, no unsent draft, nothing in flight. */
export function isBlankChatTab(tab: Tab, chatStore?: ChatStoreProbe | null): boolean {
  if (tab.type !== "chat" || !tab.entityId.startsWith("temp-")) return false;
  if (tab.isStreaming) return false;

  // Without a readable store we cannot prove the tab is blank — assume it is not.
  if (!chatStore || typeof chatStore.getChatState !== "function") return false;

  const chatState = chatStore.getChatState(tab.entityId);
  if (!chatState || !Array.isArray(chatState.messages)) return false;
  if (chatState.messages.length > 0) return false;

  // A half-typed message lives nowhere else; reusing the tab would look like
  // the composer randomly refused to clear.
  const draft =
    typeof chatStore.getDraftMessage === "function"
      ? chatStore.getDraftMessage(tab.entityId)
      : "";
  return !draft || draft.trim().length === 0;
}

/** Returns the tab a new chat may fold into, or null to create a fresh one. */
export function findReusableChatTab({
  tabs,
  chatStore,
  forceNew = false,
}: FindReusableChatTabInput): Tab | null {
  if (forceNew) return null;
  return (
    tabs.find((tab) => !isMergedTab(tab) && isBlankChatTab(tab, chatStore)) ?? null
  );
}
