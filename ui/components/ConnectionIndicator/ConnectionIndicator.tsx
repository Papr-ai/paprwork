/**
 * ConnectionIndicator - Shows Gateway WebSocket + supervisor status
 */

import React, { useEffect, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import { useGatewaySupervisorStatus } from "../../hooks/useGatewaySupervisorStatus";
import "./ConnectionIndicator.css";

export function ConnectionIndicator() {
  const [connectionState, setConnectionState] = useState<
    "connected" | "reconnecting" | "disconnected"
  >(gateway.getConnectionState());
  const {
    isStarting: gatewaySupervisorStarting,
    isRestarting: gatewaySupervisorRestarting,
    message: gatewaySupervisorMessage,
  } = useGatewaySupervisorStatus();

  useEffect(() => {
    const unsubscribe = gateway.onConnectionChange(() => {
      setConnectionState(gateway.getConnectionState());
    });

    const interval = setInterval(() => {
      setConnectionState(gateway.getConnectionState());
    }, 1000);

    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, []);

  if (gatewaySupervisorStarting) {
    return (
      <div className="connection-indicator connection-indicator--reconnecting">
        <div className="connection-indicator__dot" />
        <span className="connection-indicator__text">
          {gatewaySupervisorMessage ??
            (gatewaySupervisorRestarting
              ? "Gateway restarting..."
              : "Gateway starting...")}
        </span>
      </div>
    );
  }

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
