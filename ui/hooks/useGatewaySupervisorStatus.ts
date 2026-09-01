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
