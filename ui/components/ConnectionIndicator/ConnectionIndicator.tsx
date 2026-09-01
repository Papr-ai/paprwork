/**
 * ConnectionIndicator - Floating banner when Gateway WebSocket is offline
 */

import React from "react";
import { useGatewayConnectionState } from "../../hooks/useGatewayConnectionState";
import { useGatewaySupervisorStatus } from "../../hooks/useGatewaySupervisorStatus";
import "./ConnectionIndicator.css";

export function ConnectionIndicator() {
  const connectionState = useGatewayConnectionState();
  const {
    isStarting: gatewaySupervisorStarting,
    isRestarting: gatewaySupervisorRestarting,
    message: gatewaySupervisorMessage,
  } = useGatewaySupervisorStatus();

  if (connectionState === "connected") {
    return null;
  }

  const showSupervisorMessage =
    gatewaySupervisorStarting &&
    (connectionState === "disconnected" || gatewaySupervisorRestarting);

  const label = showSupervisorMessage
    ? (gatewaySupervisorMessage ??
      (gatewaySupervisorRestarting
        ? "Reconnecting to Gateway..."
        : "Gateway starting..."))
    : connectionState === "reconnecting"
      ? "Reconnecting..."
      : "Connection lost";

  const visualState = showSupervisorMessage
    ? "reconnecting"
    : connectionState;

  return (
    <div
      className={`connection-indicator connection-indicator--${visualState}`}
      role="status"
      aria-live="polite"
    >
      <div className="connection-indicator__dot" />
      <span className="connection-indicator__text">{label}</span>
    </div>
  );
}
