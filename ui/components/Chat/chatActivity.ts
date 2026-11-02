/**
 * chatActivity — one source of truth for a chat's status across the tab bar, the rail
 * Chats icon and peek, the tab overview and the tab-bar history dropdown.
 *
 * - working: the agent is mid-turn (same signal as the Replay glyph / composer Stop button)
 * - needs:   an open Priority/Urgent notice on the chat (a job or Pen waiting on you) — blue
 * - done:    an open FYI notice (a reply finished while you were elsewhere) — green
 *
 * needs/done come from the gateway's notices table (noticeStore), so they survive restarts
 * and show for chats that have no open tab.
 */
import { useMemo } from "react";
import { chatMarksKey, parseMarksKey, useNoticeStore } from "../../stores/noticeStore";
import { useWorkingChatIds } from "../Agent/agentWork";
import type { NoticeMark } from "../../../src/core/types/notices";

export type ChatActivity = "working" | "needs" | "done" | undefined;

export function activityFromMark(mark: NoticeMark | undefined): ChatActivity {
  if (mark === "blue") return "needs";
  if (mark === "green") return "done";
  return undefined;
}

/** Strongest open notice mark per chat id. */
export function useChatMarks(): ReadonlyMap<string, NoticeMark> {
  const key = useNoticeStore(chatMarksKey);
  return useMemo(() => parseMarksKey(key), [key]);
}

/** Chat ids with a finished reply you haven't looked at (green). */
export function useDoneChatIds(): ReadonlySet<string> {
  const marks = useChatMarks();
  return useMemo(() => new Set([...marks].filter(([, m]) => m === "green").map(([id]) => id)), [marks]);
}

/** What the Chats rail icon shows: blue if any chat needs you, else green if any reply is new. */
export function useChatsBadge(): "needs" | "done" | undefined {
  const marks = useChatMarks();
  return useMemo(() => {
    let best: "needs" | "done" | undefined;
    for (const m of marks.values()) {
      const a = activityFromMark(m);
      if (a === "needs") return "needs";
      if (a === "done") best = "done";
    }
    return best;
  }, [marks]);
}

/** Resolver for a chat's activity — working wins, then needs, then done. */
export function useChatActivity(): (chatId: string) => ChatActivity {
  const working = useWorkingChatIds();
  const marks = useChatMarks();
  return useMemo(
    () => (chatId: string) => (working.has(chatId) ? "working" : activityFromMark(marks.get(chatId))),
    [working, marks],
  );
}
