/**
 * ConnectionIndicator - Shows Gateway WebSocket connection status
 * Displays: Connected (green), Reconnecting (yellow), Disconnected (red)
 */

import React, { useEffect, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import "./ConnectionIndicator.css";

export function ConnectionIndicator() {
  const [connectionState, setConnectionState] = useState<
    "connected" | "reconnecting" | "disconnected"
  >(gateway.getConnectionState());

  useEffect(() => {
    // Update state when connection changes
    const unsubscribe = gateway.onConnectionChange((connected) => {
      setConnectionState(gateway.getConnectionState());
    });

    // Also check state periodically (for reconnecting → disconnected transition)
    const interval = setInterval(() => {
      setConnectionState(gateway.getConnectionState());
    }, 1000);

    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, []);

  // Don't show indicator when connected (clean UI)
  if (connectionState === "connected") {
    return null;
  }

  return (
    <div className={`connection-indicator connection-indicator--${connectionState}`}>
      <div className="connection-indicator__dot" />
      <span className="connection-indicator__text">
        {connectionState === "reconnecting" ? "Reconnecting..." : "Disconnected"}
      </span>
    </div>
  );
}
