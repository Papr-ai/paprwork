import { useEffect, useState } from "react";
import { gateway } from "../src/lib/gateway";

export type GatewaySupervisorStatus =
  | "unknown"
  | "starting"
  | "ready"
  | "restarting"
  | "running";

interface GatewayStatusPayload {
  status: string;
  message?: string;
}

function normalizeStatus(status: string): GatewaySupervisorStatus {
  if (status === "running") return "ready";
  if (
    status === "starting" ||
    status === "ready" ||
    status === "restarting"
  ) {
    return status;
  }
  return "unknown";
}

export function useGatewaySupervisorStatus(): {
  status: GatewaySupervisorStatus;
  message: string | undefined;
  isReady: boolean;
  isStarting: boolean;
  isRestarting: boolean;
} {
  const [status, setStatus] = useState<GatewaySupervisorStatus>("unknown");
  const [message, setMessage] = useState<string | undefined>();

  useEffect(() => {
    const api = (
      window as unknown as {
        electronAPI?: {
          gateway?: {
            onStatusChange?: (cb: (data: GatewayStatusPayload) => void) => void;
            removeStatusListener?: () => void;
          };
        };
      }
    ).electronAPI?.gateway;

    if (!api?.onStatusChange) {
      return undefined;
    }

    api.onStatusChange((data) => {
      setStatus(normalizeStatus(data.status));
      setMessage(data.message);
    });

    // If the renderer missed a "ready" IPC (common after sleep/wake), infer
    // readiness from a live WebSocket so banners do not stay stuck.
    //
    // Note what this can and cannot tell us: the handshake succeeds as soon as
    // the port is bound, which the gateway does *before* registering its HTTP
    // routes, so "connected" does not mean "routable". Fine for clearing a
    // banner; not a basis for anything that would fail against a missing route.
    // See gatewayBootGate.ts, which answers 503 for that window.
    const clearStaleSupervisorState = (): void => {
      if (!gateway.isConnected()) return;
      setStatus((prev) =>
        prev === "starting" || prev === "restarting" ? "ready" : prev,
      );
      setMessage(undefined);
    };

    clearStaleSupervisorState();
    const unsubscribe = gateway.onConnectionChange((connected) => {
      if (connected) clearStaleSupervisorState();
    });

    return () => {
      unsubscribe();
      api.removeStatusListener?.();
    };
  }, []);

  const isReady = status === "ready" || status === "running";
  const isRestarting = status === "restarting";
  const isStarting = status === "starting" || isRestarting;

  return { status, message, isReady, isStarting, isRestarting };
}
