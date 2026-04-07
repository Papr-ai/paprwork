/**
 * ExploringCard Component - Displays tool calls/actions
 * Matches ThinkingCard style - collapsible, minimal design
 * Shows detailed tool info like V1 (especially bash commands)
 */

import React, { useState } from "react";
import type { ToolCall } from "../../types/core";
import { getToolDisplayLabel } from "../../utils/toolDisplay";
import { PaprLogoIcon } from "./PaprLogoIcon";
import "./ExploringCard.css";

interface ExploringCardProps {
  toolCalls: ToolCall[];
  isStreaming?: boolean;
  narration?: string;
}

export const ExploringCard: React.FC<ExploringCardProps> = ({
  toolCalls,
  isStreaming = false,
  narration,
}) => {
  // Start collapsed by default
  const [manuallyToggled, setManuallyToggled] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(true);
  
  // Timer state
  const [elapsedTime, setElapsedTime] = useState(0);
  const startTimeRef = React.useRef<number | null>(null);
  const timerIntervalRef = React.useRef<NodeJS.Timeout | null>(null);

  // Start timer when exploring begins
  React.useEffect(() => {
    const isExploring = isStreaming || toolCalls.some((t) => t.status === "calling");
    
    if (isExploring && !startTimeRef.current) {
      // Start timing
      startTimeRef.current = Date.now();
      timerIntervalRef.current = setInterval(() => {
        if (startTimeRef.current) {
          setElapsedTime(Math.floor((Date.now() - startTimeRef.current) / 1000));
        }
      }, 1000);
    } else if (!isExploring && startTimeRef.current) {
      // Stop timing
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
      // Set final time
      if (startTimeRef.current) {
        setElapsedTime(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }
    }

    // Cleanup on unmount
    return () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
      }
    };
  }, [isStreaming, toolCalls]);

  // Keep collapsed when streaming ends (unless user manually expanded/collapsed)
  React.useEffect(() => {
    if (!isStreaming && !manuallyToggled) {
      setIsCollapsed(true);
    }
  }, [isStreaming, manuallyToggled]);

  // Don't show if there are no tool calls
  if (toolCalls.length === 0) {
    return null;
  }

  const handleToggle = () => {
    setIsCollapsed(!isCollapsed);
    setManuallyToggled(true);
  };

  const isExploring =
    isStreaming || toolCalls.some((t) => t.status === "calling");
  
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
    <div className="exploring-card">
      <div className="exploring-card-header" onClick={handleToggle}>
        <span
          className={`exploring-chevron ${isCollapsed ? "exploring-chevron-collapsed" : ""}`}
        >
          ▼
        </span>
        <span className="exploring-label-text">Working</span>
        {isExploring && <PaprLogoIcon />}
        {elapsedTime > 0 && (
          <span className="exploring-timer">{formatTime(elapsedTime)}</span>
        )}
      </div>
      <div
        className="exploring-card-content"
        style={{
          maxHeight: isCollapsed ? "0px" : "200px",
          opacity: isCollapsed ? "0" : "1",
        }}
      >
        {toolCalls.map((toolCall, index) => {
          const displayText = getToolDisplayLabel(toolCall);

          // Determine status indicator
          let statusIndicator = null;
          if (toolCall.status === "calling") {
            // Loading indicator - liquid glass style pulsing dot
            statusIndicator = (
              <span className="exploring-tool-loading">
                <span className="exploring-tool-dot"></span>
              </span>
            );
          } else if (toolCall.status === "success") {
            // Success checkmark
            statusIndicator = <span className="exploring-tool-success">✓</span>;
          } else if (toolCall.status === "error") {
            // Error X
            statusIndicator = <span className="exploring-tool-error">✗</span>;
          }

          return (
            <div key={toolCall.id || index} className="exploring-tool-item">
              <span className="exploring-tool-arrow">→</span>
              <span className="exploring-tool-name">{displayText}</span>
              {statusIndicator}
            </div>
          );
        })}

        {/* Show agent narration after tool calls */}
        {narration && <div className="exploring-narration">{narration}</div>}
      </div>
    </div>
  );
};
