import { useEffect, useState } from "react";
import { gateway } from "../src/lib/gateway";

export type GatewayConnectionState = "connected" | "reconnecting" | "disconnected";

export function useGatewayConnectionState(): GatewayConnectionState {
  const [connectionState, setConnectionState] = useState<GatewayConnectionState>(
    gateway.getConnectionState(),
  );

  useEffect(() => {
    const sync = (): void => {
      setConnectionState(gateway.getConnectionState());
    };

    const unsubscribe = gateway.onConnectionChange(sync);
    const interval = setInterval(sync, 1000);

    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, []);

  return connectionState;
}
