/**
 * chatActivity — one source of truth for a chat's status across the tab bar, the rail
 * Chats peek, and the tab-bar history dropdown.
 *
 * - working: the agent is mid-turn (same signal as the Replay glyph / composer Stop button)
 * - done:    the turn finished while you were elsewhere — the tab's green dot (tab.hasUnread)
 */
import { useMemo } from "react";
import { useTabStore } from "../../stores/tabStore";
import { useWorkingChatIds } from "../Agent/agentWork";

export type ChatActivity = "working" | "done" | undefined;

/** Sorted id string so the selector result stays stable between unrelated tab updates. */
function unreadKey(s: ReturnType<typeof useTabStore.getState>): string {
  return s.tabs
    .filter((t) => t.type === "chat" && t.hasUnread)
    .map((t) => t.entityId)
    .sort()
    .join("|");
}

/** Chat ids whose tab shows the green "done" dot. */
export function useDoneChatIds(): ReadonlySet<string> {
  const key = useTabStore(unreadKey);
  return useMemo(() => new Set(key ? key.split("|") : []), [key]);
}

/** Resolver for a chat's activity — working wins over done. */
export function useChatActivity(): (chatId: string) => ChatActivity {
  const working = useWorkingChatIds();
  const done = useDoneChatIds();
  return useMemo(
    () => (chatId: string) =>
      working.has(chatId) ? "working" : done.has(chatId) ? "done" : undefined,
    [working, done],
  );
}
