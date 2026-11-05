/**
 * ChatStatusMark — the single status glyph for a chat row, shared by the rail Chats peek and
 * the tab-bar history dropdown so both read exactly like the tab bar:
 * working → the agent's Replay mark; needs → blue dot (waiting on you); done → green dot (new reply).
 */
import { AgentGlyph } from "../Agent/AgentGlyph";
import { useAgentIdentity, useAgentName } from "../Agent/agentIdentityStore";
import type { ChatActivity } from "./chatActivity";
import "./ChatStatusMark.css";

export function ChatStatusMark({ activity }: { activity: ChatActivity }) {
  const name = useAgentName();
  const papr = useAgentIdentity((s) => s.look) === "papr";
  if (activity === "working") {
    return (
      <span className="chat-status-mark" role="img" aria-label={`${name} is working`} title={`${name} is working`}>
        <AgentGlyph size={papr ? 14 : 16} state="working" />
      </span>
    );
  }
  if (activity === "needs") {
    return (
      <span className="chat-status-mark" role="img" aria-label="Needs you" title="Needs you">
        <i className="chat-status-mark__done chat-status-mark__needs" />
      </span>
    );
  }
  if (activity === "done") {
    return (
      <span className="chat-status-mark" role="img" aria-label="New reply" title="New reply">
        <i className="chat-status-mark__done" />
      </span>
    );
  }
  return null;
}
