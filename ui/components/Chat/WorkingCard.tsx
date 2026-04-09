/**
 * WorkingCard Component - Displays tool execution progress with timer
 * Supports collapsing and shows elapsed time
 */

import React, { useState, useEffect, useRef } from "react";
import { PaprLogoIcon } from "./PaprLogoIcon";
import "./WorkingCard.css";

interface WorkingCardProps {
  children: React.ReactNode;
  isExploring?: boolean;
  elapsedSeconds?: number; // Server-provided elapsed time
}

export const WorkingCard: React.FC<WorkingCardProps> = ({
  children,
  isExploring = false,
  elapsedSeconds = 0,
}) => {
  // Start collapsed by default
  const [isCollapsed, setIsCollapsed] = useState(true);
  
  // Use server-provided elapsed time directly
  // No client-side timing needed - backend knows exactly when work started/stopped
  const displayTime = elapsedSeconds;

  // Format elapsed time as "Xs" or "Xm Ys" for minutes
  const formatTime = (seconds: number): string => {
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  };

  return (
    <div className="working-card">
      <div className="working-card-header" onClick={() => setIsCollapsed(!isCollapsed)}>
        <span
          className={`working-chevron ${isCollapsed ? "working-chevron-collapsed" : ""}`}
        >
          ▼
        </span>
        <span className="working-label-text">Working</span>
        {isExploring && <PaprLogoIcon />}
        {displayTime > 0 && (
          <span className="working-timer">{formatTime(displayTime)}</span>
        )}
      </div>
      <div
        className="working-card-content"
        style={{
          maxHeight: isCollapsed ? "0px" : "420px",
          opacity: isCollapsed ? "0" : "1",
        }}
      >
        {children}
      </div>
    </div>
  );
};
