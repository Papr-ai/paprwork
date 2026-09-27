/**
 * AgentGlyph — renders the user's agent (Papr mark or a face: Orb / Tile / Hex) in their color.
 * Faces are an outline + two eye pills; the eyes glance and blink via agentLife.ts.
 */
import { useEffect, useId, type CSSProperties } from "react";
import {
  agentStops,
  useAgentIdentity,
  type AgentColor,
  type AgentLook,
} from "./agentIdentityStore";
import { startAgentLife } from "./agentLife";
import "./AgentGlyph.css";

const PAPR_PATH =
  "M27.9998 101.5C-11.5 158 6.99988 51 43.4008 60.5002C99.2884 75.0861 115.18 20.7781 83.6804 8.27816C40.2693 -8.94844 51.9998 65 27.9998 101.5Z";

function Shape({ look }: { look: Exclude<AgentLook, "papr"> }) {
  if (look === "tile") return <rect x="2.8" y="2.8" width="34.4" height="34.4" rx="11" />;
  if (look === "hex") return <path d="M20 2.2 35.6 11.1v17.8L20 37.8 4.4 28.9V11.1z" />;
  return <circle cx="20" cy="20" r="17.4" />;
}

interface AgentGlyphProps {
  /** Box size in px. The Papr mark sits at ~72% of the box; faces fill it. */
  size: number;
  /** Override the stored look/color (used by the personalize sheet previews). */
  look?: AgentLook;
  color?: AgentColor;
  className?: string;
}

export function AgentGlyph({ size, look, color, className = "" }: AgentGlyphProps) {
  const storedLook = useAgentIdentity((s) => s.look);
  const storedColor = useAgentIdentity((s) => s.color);
  const l = look ?? storedLook;
  const c = color ?? storedColor;
  const [a, b, d] = agentStops(c);
  const gid = `agent-grad-${useId().replace(/:/g, "")}`;

  useEffect(() => {
    startAgentLife();
  }, []);

  const style = { width: size, height: size, "--agent-a1": a, "--agent-a2": b } as CSSProperties;
  const stops = (
    <>
      <stop stopColor={a} />
      <stop offset="0.6" stopColor={b} />
      <stop offset="1" stopColor={d} />
    </>
  );

  if (l === "papr") {
    return (
      <span className={`agent-glyph agent-glyph--papr ${className}`} style={style} aria-hidden="true">
        <svg viewBox="0 0 105 124" fill="none">
          <defs>
            <linearGradient id={gid} x1="17" y1="89" x2="69" y2="36" gradientUnits="userSpaceOnUse">
              {stops}
            </linearGradient>
          </defs>
          <path d={PAPR_PATH} stroke={`url(#${gid})`} strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }

  return (
    <span className={`agent-glyph agent-glyph--face ${className}`} style={style} aria-hidden="true">
      <svg viewBox="0 0 40 40" fill="none">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
            {stops}
          </linearGradient>
        </defs>
        <g stroke={`url(#${gid})`} strokeWidth="3" strokeLinejoin="round" fill={`url(#${gid})`} fillOpacity="0.07">
          <Shape look={l} />
        </g>
        <g className="agent-glyph__eyes">
          <g className="agent-glyph__lids" fill={`url(#${gid})`}>
            <rect x="14.3" y="14.5" width="3.9" height="11" rx="1.95" />
            <rect x="21.8" y="14.5" width="3.9" height="11" rx="1.95" />
          </g>
        </g>
      </svg>
    </span>
  );
}
