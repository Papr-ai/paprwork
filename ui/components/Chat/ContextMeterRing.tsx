/**
 * The dial. One number, no chrome.
 *
 * At rest it is a ring and nothing else — the percentage only earns its pixels
 * once the window is actually filling up (or the pointer asks).
 */

import React from "react";
import type { MeterStatus } from "./contextMeterModel";

interface ContextMeterRingProps {
  /** 0–1 fill. */
  fraction: number;
  status: MeterStatus;
  size?: number;
  /** Render the percentage beside the ring. */
  showLabel?: boolean;
  /**
   * A turn is running. Steps land seconds apart, so between them the fill is
   * genuinely unchanged — without this the dial is indistinguishable from a
   * dead one during exactly the wait it is supposed to narrate.
   */
  live?: boolean;
}

const STROKE = 2.5;

export const ContextMeterRing: React.FC<ContextMeterRingProps> = ({
  fraction,
  status,
  size = 20,
  showLabel = false,
  live = false,
}) => {
  const radius = (size - STROKE) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(fraction, 1));
  const percent = Math.round(clamped * 100);

  return (
    <span className={`ctx-ring ctx-ring--${status}${live ? " is-live" : ""}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          className="ctx-ring__track"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={STROKE}
          fill="none"
        />
        {/* Painted after the track and before the fill, so it reads as motion
            *in* the empty part of the dial. It reports activity and nothing
            else — deliberately not tied to progress, because the one thing a
            running turn cannot know is how many steps are left. */}
        {live ? (
          <circle
            className="ctx-ring__sweep"
            cx={size / 2}
            cy={size / 2}
            r={radius}
            strokeWidth={STROKE}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={`${circumference * 0.22} ${circumference}`}
          />
        ) : null}
        <circle
          className="ctx-ring__fill"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={STROKE}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      {showLabel ? <span className="ctx-ring__label">{percent}%</span> : null}
    </span>
  );
};
