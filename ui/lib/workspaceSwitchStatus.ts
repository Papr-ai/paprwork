/**
 * Poll gateway workspace switch status when WebSocket switch-complete may be missed.
 */

export interface GatewayWorkspaceSwitchStatus {
  active: boolean;
  phase: string;
  organizationId?: string;
  namespaceId?: string;
}

const DEFAULT_GATEWAY_PORT = "18789";

function getGatewayBaseUrl(): string {
  const host = import.meta.env.VITE_GATEWAY_HOST || "127.0.0.1";
  const port = import.meta.env.VITE_GATEWAY_PORT || DEFAULT_GATEWAY_PORT;
  return `http://${host}:${port}`;
}

export async function fetchGatewayWorkspaceSwitchStatus(): Promise<GatewayWorkspaceSwitchStatus | null> {
  try {
    const response = await fetch(`${getGatewayBaseUrl()}/api/workspace/switch-status`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as GatewayWorkspaceSwitchStatus;
    if (typeof data.active !== "boolean" || typeof data.phase !== "string") {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/** True when the gateway is not actively switching and the last switch finished. */
export function isGatewayWorkspaceSwitchComplete(
  status: GatewayWorkspaceSwitchStatus,
): boolean {
  return !status.active && (status.phase === "complete" || status.phase === "idle");
}
