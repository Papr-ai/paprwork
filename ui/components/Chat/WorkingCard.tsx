/**
 * WorkingCard Component - Displays tool execution progress
 * Supports collapsing and shows current activity
 */

import React, { useState } from "react";
import "./WorkingCard.css";

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
  // Start collapsed by default
  const [isCollapsed, setIsCollapsed] = useState(true);

  return (
    <div className="working-card">
      <div className="working-card-header" onClick={() => setIsCollapsed(!isCollapsed)}>
        <span
          className={`working-chevron ${isCollapsed ? "working-chevron-collapsed" : ""}`}
        >
          ▼
        </span>
        <div className="working-label-container">
          <span className="working-label-primary">
            {isExploring ? "Working" : "Finished Working"}
          </span>
          {isCollapsed && lastActivity && (
            <span className="working-label-secondary">
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
