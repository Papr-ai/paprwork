/**
 * ExploringCard Component - Displays tool calls/actions
 * Matches ThinkingCard style - collapsible, minimal design
 * Shows detailed tool info like V1 (especially bash commands)
 */

import React, { useState } from "react";
import type { ToolCall } from "../../types/core";
import { getToolDisplayLabel } from "../../utils/toolDisplay";
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
  // Start collapsed (can be manually expanded by user)
  // V1 behavior: Keep card open showing completed tool calls, with assistant text below
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Don't show if there are no tool calls
  if (toolCalls.length === 0) {
    return null;
  }

  return (
    <div className="exploring-card">
      <div
        className="exploring-card-header"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <span
          className={`exploring-chevron ${isCollapsed ? "exploring-chevron-collapsed" : ""}`}
        >
          ▼
        </span>
        <span className="exploring-label-text">Exploring</span>
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
