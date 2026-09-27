/**
 * AgentPersonalizeSheet — one job: make the agent yours.
 * Live preview on top, three choices below (name, look, color), one Done.
 */
import { useEffect, type CSSProperties } from "react";
import { AgentGlyph } from "./AgentGlyph";
import {
  AGENT_COLORS,
  AGENT_LOOKS,
  AGENT_NAME_MAX,
  DEFAULT_AGENT,
  useAgentIdentity,
  useAgentName,
} from "./agentIdentityStore";
import "./AgentPersonalizeSheet.css";

export function AgentPersonalizeSheet() {
  const { sheetOpen, look, color, name, update, reset, closeSheet } = useAgentIdentity();
  const displayName = useAgentName();

  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSheet();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetOpen, closeSheet]);

  if (!sheetOpen) return null;

  const isDefault =
    look === DEFAULT_AGENT.look && color === DEFAULT_AGENT.color && name === DEFAULT_AGENT.name;

  return (
    <div className="agent-sheet-layer">
      <div className="agent-sheet-scrim" onClick={closeSheet} />
      <div className="agent-sheet" role="dialog" aria-modal="true" aria-label="Your agent">
        <div className="agent-sheet__preview" data-agent-hover>
          <AgentGlyph size={76} />
          <b>{displayName}</b>
          <span>Your agent in every chat, app and job</span>
        </div>

        <label className="agent-sheet__field">
          <span>Name</span>
          <input
            autoFocus
            value={name}
            maxLength={AGENT_NAME_MAX}
            spellCheck={false}
            autoComplete="off"
            placeholder={DEFAULT_AGENT.name}
            onChange={(e) => update({ name: e.target.value })}
          />
        </label>

        <div className="agent-sheet__field">
          <span>Look</span>
          <div className="agent-sheet__looks">
            {AGENT_LOOKS.map((l) => (
              <button
                key={l.id}
                type="button"
                className={`agent-sheet__look${l.id === look ? " is-on" : ""}`}
                aria-label={l.label}
                aria-pressed={l.id === look}
                title={l.label}
                data-agent-hover
                onClick={() => update({ look: l.id })}
              >
                <AgentGlyph size={30} look={l.id} />
              </button>
            ))}
          </div>
        </div>

        <div className="agent-sheet__field">
          <span>Color</span>
          <div className="agent-sheet__colors">
            {AGENT_COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`agent-sheet__color${c.id === color ? " is-on" : ""}`}
                style={{ "--agent-a1": c.stops[0], "--agent-a2": c.stops[2] } as CSSProperties}
                aria-label={c.label}
                aria-pressed={c.id === color}
                title={c.label}
                onClick={() => update({ color: c.id })}
              />
            ))}
          </div>
        </div>

        <footer className="agent-sheet__footer">
          {isDefault ? (
            <span />
          ) : (
            <button type="button" className="agent-sheet__reset" onClick={reset}>
              Reset to {DEFAULT_AGENT.name}
            </button>
          )}
          <button type="button" className="agent-sheet__done" onClick={closeSheet}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
