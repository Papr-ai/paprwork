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
}

export const WorkingCard: React.FC<WorkingCardProps> = ({
  children,
  isExploring = false,
  lastActivity,
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
      <div className="working-card-header" onClick={() => setIsCollapsed(!isCollapsed)}>
        <span
          className={`working-chevron ${isCollapsed ? "working-chevron-collapsed" : ""}`}
        >
          ▼
        </span>
        <div className="working-label-container">
          <span className={`working-label-primary${shimmerActive ? " working-label-shimmer" : ""}`}>
            {isExploring ? "Working" : "Finished Working"}
          </span>
          {isCollapsed && lastActivity && (
            <span className={`working-label-secondary${shimmerActive ? " working-secondary-shimmer" : ""}`}>
              {lastActivity}
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
