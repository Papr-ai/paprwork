/**
 * AgentNudge — "The Lean". When something slips, your agent leans out of the rail toward you and one
 * flat dot in its color slides out and opens into a single sentence. No red badge, no bell, no loop.
 * Ignore it and it settles on the agent as one still dot; tap the dot to hear it again.
 * Timing / frequency: useAgentNudge.ts (breakpoints) + gateway nudgePolicy.ts (caps, backoff).
 */
import type { CSSProperties } from "react";
import { agentStops, useAgentIdentity, useAgentName } from "./agentIdentityStore";
import type { AgentNudgeData, NudgePhase } from "./useAgentNudge";
import "./AgentNudge.css";

interface AgentNudgeProps {
  nudge: AgentNudgeData | null;
  phase: NudgePhase;
  onGo: () => void;
  onLater: () => void;
  onDismiss: () => void;
  onReopen: () => void;
  onHold: (on: boolean) => void;
}

export function AgentNudge({ nudge, phase, onGo, onLater, onDismiss, onReopen, onHold }: AgentNudgeProps) {
  const name = useAgentName();
  const color = useAgentIdentity((s) => s.color);
  if (!nudge || phase === "off") return null;
  const [a1, a2] = agentStops(color);
  const style = { "--nudge-a1": a1, "--nudge-a2": a2 } as CSSProperties;

  if (phase === "rest") {
    return (
      <button type="button" className="agent-nudge__rest" style={style} onClick={onReopen} aria-label={`${name} has a nudge`} />
    );
  }

  return (
    <>
      <span className="agent-nudge__dot" style={style} aria-hidden="true" />
      <div
        className="agent-nudge"
        style={style}
        role="status"
        aria-live="polite"
        onMouseEnter={() => onHold(true)}
        onMouseLeave={() => onHold(false)}
      >
        <small>{name}</small>
        <p>{nudge.line}</p>
        {nudge.sub ? <span className="agent-nudge__sub">{nudge.sub}</span> : null}
        <footer>
          <button type="button" className="agent-nudge__go" onClick={onGo}>
            {nudge.go}
          </button>
          {nudge.dismiss ? (
            <button type="button" className="agent-nudge__later" onClick={onDismiss}>
              {nudge.dismiss}
            </button>
          ) : (
            <button type="button" className="agent-nudge__later" onClick={onLater}>
              {nudge.later}
            </button>
          )}
        </footer>
      </div>
    </>
  );
}
