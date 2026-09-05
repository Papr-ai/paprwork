import React from "react";
import "./MessageList.css";

/** Bouncing dots shown while waiting for the first assistant tokens. */
export function AgentLoadingDots(): React.ReactElement {
  return (
    <div
      className="agent-loading-indicator"
      data-testid="agent-loading-indicator"
    >
      <div className="loading-dots">
        <span></span>
        <span></span>
        <span></span>
      </div>
    </div>
  );
}
