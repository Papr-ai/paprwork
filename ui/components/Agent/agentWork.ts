/**
 * Agent work state for "Replay": while your agent is working in any chat, one point of light
 * retraces the agent's own mark (see AgentGlyph `state`). When the last chat finishes, the stroke
 * completes itself once ("done"), then rests.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useChatStore } from "../../stores/chatStore";
import { isUserFacingChatId } from "../../utils/chatVisibility";

export type AgentWorkState = "idle" | "working" | "done";

/** Matches the length of the seal animation in AgentGlyph.css. */
const SEAL_MS = 1500;

type ChatStoreState = ReturnType<typeof useChatStore.getState>;

/**
 * A chat is "working" while the agent is streaming a reply OR running tools between replies
 * (`isAgentRunning` — the same signal the chat's "Working on it…" card uses). Tracked per chat in
 * `chatStates`; the chat-list metadata flag can lag behind. Returned as a sorted id string so the
 * selector result is stable between unrelated store updates.
 */
export function isChatWorking(state: { isStreaming?: boolean; isAgentRunning?: boolean }): boolean {
  return !!(state.isStreaming || state.isAgentRunning);
}

function workingKey(s: ChatStoreState): string {
  const ids: string[] = [];
  s.chatStates.forEach((state, id) => {
    if (isChatWorking(state) && isUserFacingChatId(id)) ids.push(id);
  });
  return ids.sort().join("|");
}

/** Ids of user-facing chats your agent is currently working in. */
export function useWorkingChatIds(): ReadonlySet<string> {
  const key = useChatStore(workingKey);
  return useMemo(() => new Set(key ? key.split("|") : []), [key]);
}

export function useAgentWork(): { state: AgentWorkState; count: number } {
  const count = useWorkingChatIds().size;
  const [sealing, setSealing] = useState(false);
  const prev = useRef(count);

  useEffect(() => {
    const finished = prev.current > 0 && count === 0;
    prev.current = count;
    if (!finished) {
      if (count > 0) setSealing(false);
      return;
    }
    setSealing(true);
    const t = window.setTimeout(() => setSealing(false), SEAL_MS);
    return () => window.clearTimeout(t);
  }, [count]);

  return { state: count > 0 ? "working" : sealing ? "done" : "idle", count };
}
