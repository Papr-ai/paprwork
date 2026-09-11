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
}

const STROKE = 2.5;

export const ContextMeterRing: React.FC<ContextMeterRingProps> = ({
  fraction,
  status,
  size = 20,
  showLabel = false,
}) => {
  const radius = (size - STROKE) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(fraction, 1));
  const percent = Math.round(clamped * 100);

  return (
    <span className={`ctx-ring ctx-ring--${status}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          className="ctx-ring__track"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={STROKE}
          fill="none"
        />
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
