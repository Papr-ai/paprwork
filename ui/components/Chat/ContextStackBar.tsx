/**
 * The window, drawn once: filled by composition, with the free space left over.
 *
 * Fullness has exactly one source — the measured prompt of the last turn — so
 * the estimated composition is normalised to it. Otherwise the bar and the
 * percentage above it would tell two different stories about the same window.
 */

import React from "react";
import {
  formatTokens,
  type ContextSegment,
  type MeterStatus,
} from "./contextMeterModel";

interface ContextStackBarProps {
  segments: ContextSegment[];
  /** Measured tokens in the window. */
  usedTokens: number;
  window: number;
  status: MeterStatus;
  highlightId?: string | null;
}

export const ContextStackBar: React.FC<ContextStackBarProps> = ({
  segments,
  usedTokens,
  window: windowTokens,
  status,
  highlightId,
}) => {
  const estimated = segments.reduce((sum, s) => sum + s.tokens, 0);
  const filled = Math.min((usedTokens || estimated) / windowTokens, 1);
  const scale = estimated > 0 ? filled / estimated : 0;

  return (
    <div className={`ctx-stack ctx-stack--${status}`}>
      {estimated > 0 ? (
        segments.map((segment) => (
          <span
            key={segment.id}
            className={`ctx-stack__seg ctx-stack__seg--${segment.tone}${
              highlightId === segment.id ? " is-active" : ""
            }`}
            style={{
              width: `${segment.tokens * scale * 100}%`,
              opacity: highlightId && highlightId !== segment.id ? 0.3 : 1,
            }}
            title={`${segment.label} — ${formatTokens(segment.tokens)}`}
          />
        ))
      ) : (
        <span
          className="ctx-stack__seg ctx-stack__seg--pending"
          style={{ width: `${filled * 100}%` }}
        />
      )}
    </div>
  );
};
