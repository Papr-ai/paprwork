/**
 * Chat toggle for the tab bar (⌘J / Ctrl+J).
 *
 * - App or document tab with no chat → create a chat and merge it on the left.
 * - Chat | app/doc pair → collapse or restore the chat pane (the pair is kept).
 * - Anything else (chat-only, lists, Focus, Memory, …) → no toggle.
 */

import type { Tab } from "../types/tabs";

const PAIRABLE_TYPES = new Set(["app", "document"]);

export type ChatToggleInfo =
  | { mode: "create"; appTabId: string }
  | { mode: "toggle"; parentTabId: string; hidden: boolean };

export function getChatToggleInfo(
  tab: Tab | undefined,
  getTab: (id: string) => Tab | undefined,
): ChatToggleInfo | null {
  if (!tab) return null;

  if (tab.displayMode === "standalone" && PAIRABLE_TYPES.has(tab.type)) {
    return { mode: "create", appTabId: tab.id };
  }

  if (tab.displayMode === "parent" && tab.type === "chat") {
    const child = tab.childTabIds[0] ? getTab(tab.childTabIds[0]) : undefined;
    if (child && PAIRABLE_TYPES.has(child.type)) {
      return {
        mode: "toggle",
        parentTabId: tab.id,
        hidden: tab.chatHidden === true,
      };
    }
  }

  return null;
}
