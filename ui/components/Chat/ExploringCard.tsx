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
  // Auto-collapse when streaming ends (V1 behavior)
  // Start expanded during streaming, then collapse when done
  const [manuallyToggled, setManuallyToggled] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Auto-collapse when streaming ends (unless user manually expanded/collapsed)
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
