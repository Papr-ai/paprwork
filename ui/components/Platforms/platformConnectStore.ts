/**
 * Platform Connect Store
 *
 * Zustand store for platform connection requests from the agent.
 * When the agent needs a platform connected, it sends a request
 * that triggers the branded connection modal.
 */

import { create } from "zustand";
import { gateway } from "../../src/lib/gateway";

export type PlatformId =
  // Social
  | "linkedin"
  | "instagram"
  | "reddit"
  | "facebook"
  | "tiktok"
  | "twitter"
  | "telegram";

export interface PlatformConnectRequest {
  platform: PlatformId;
  reason?: string; // Why the agent needs this connection
  requestId: string;
}

interface PlatformConnectState {
  activeRequest: PlatformConnectRequest | null;
  setActiveRequest: (request: PlatformConnectRequest | null) => void;
  clearRequest: () => void;
}

export const usePlatformConnectStore = create<PlatformConnectState>((set) => ({
  activeRequest: null,

  setActiveRequest: (request) => set({ activeRequest: request }),

  clearRequest: () => set({ activeRequest: null }),
}));

async function isPlatformAlreadyConnected(platformId: PlatformId): Promise<boolean> {
  try {
    const response = await gateway.send("platform:get-status", { platformId });
    const data = response.data as { status?: string } | undefined;
    return data?.status === "connected";
  } catch {
    return false;
  }
}

/**
 * Initialize listener for platform connection requests from gateway.
 * Call once at app root.
 */
export function initPlatformConnectListener(): void {
  const handleBroadcast = (event: Event) => {
    const customEvent = event as CustomEvent;
    const message = customEvent.detail;

    if (message.type === "platform:connect-request") {
      const platformId = message.data.platformId as PlatformId;
      console.log("[PlatformConnectStore] Connection request:", message.data);

      void (async () => {
        if (await isPlatformAlreadyConnected(platformId)) {
          console.log(
            `[PlatformConnectStore] ${platformId} already connected — skipping modal`,
          );
          return;
        }

        usePlatformConnectStore.getState().setActiveRequest({
          platform: platformId,
          reason: message.data.reason,
          requestId: message.data.requestId || crypto.randomUUID(),
        });
      })();
    }

    if (message.type === "platform:status-changed") {
      const { platformId, status } = message.data as {
        platformId: PlatformId;
        status: string;
      };
      const activeRequest = usePlatformConnectStore.getState().activeRequest;

      if (activeRequest?.platform === platformId && status === "connected") {
        console.log("[PlatformConnectStore] Connection successful, dismissing modal");
        usePlatformConnectStore.getState().clearRequest();
      }
    }
  };

  window.addEventListener("gateway-broadcast", handleBroadcast);
}
