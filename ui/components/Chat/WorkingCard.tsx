/**
 * WorkingCard Component - Displays tool execution progress
 * Supports collapsing and shows current activity
 */

import React, { useState, useEffect, useRef } from "react";
import "./WorkingCard.css";

const SHIMMER_DELAY_MS = 3000;

interface WorkingCardProps {
  children: React.ReactNode;
  isExploring?: boolean;
  lastActivity?: string; // Last tool call or response text
  wasStopped?: boolean; // Whether the agent was manually stopped
  connectionPaused?: boolean; // Gateway disconnected mid-stream
}

export const WorkingCard: React.FC<WorkingCardProps> = ({
  children,
  isExploring = false,
  lastActivity,
  wasStopped = false,
  connectionPaused = false,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [showShimmer, setShowShimmer] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setShowShimmer(false);

    if (timerRef.current) clearTimeout(timerRef.current);

    if (isExploring) {
      timerRef.current = setTimeout(() => setShowShimmer(true), SHIMMER_DELAY_MS);
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [lastActivity, isExploring]);

  const shimmerActive = isExploring && showShimmer;

  return (
    <div className="working-card">
      <div 
        className="working-card-header" 
        onMouseDown={(e) => {
          e.preventDefault(); // Prevent input from losing focus
          setIsCollapsed(!isCollapsed);
        }}
      >
        <span
          className={`working-chevron ${isCollapsed ? "working-chevron-collapsed" : ""}`}
        >
          ▼
        </span>
        <div className="working-label-container">
          <span className={`working-label-primary${shimmerActive ? " working-label-shimmer" : ""}`}>
            {connectionPaused
              ? "Reconnecting"
              : isExploring
                ? "Working"
                : wasStopped
                  ? "Stopped"
                  : "Finished Working"}
          </span>
          {isCollapsed && (connectionPaused || lastActivity) && (
            <span className={`working-label-secondary${shimmerActive ? " working-secondary-shimmer" : ""}`}>
              {connectionPaused
                ? "Connection paused — resuming when back online"
                : lastActivity}
            </span>
          )}
        </div>
      </div>
      <div
        className={`working-card-content ${isCollapsed ? "working-card-content--collapsed" : ""}`}
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
