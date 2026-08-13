/**
 * Platform Connect Store
 *
 * Zustand store for platform connection requests from the agent.
 * When the agent needs a platform connected, it sends a request
 * that triggers the branded connection modal.
 */

import { create } from "zustand";

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

/**
 * Initialize listener for platform connection requests from gateway.
 * Call once at app root.
 */
export function initPlatformConnectListener(): void {
  // Listen for gateway broadcasts
  const handleBroadcast = (event: Event) => {
    const customEvent = event as CustomEvent;
    const message = customEvent.detail;

    // Handle connection request from agent
    if (message.type === "platform:connect-request") {
      console.log("[PlatformConnectStore] Connection request:", message.data);
      usePlatformConnectStore.getState().setActiveRequest({
        platform: message.data.platformId,
        reason: message.data.reason,
        requestId: message.data.requestId || crypto.randomUUID(),
      });
    }

    // Handle connection success - dismiss modal
    if (message.type === "platform:status-change") {
      const { platformId, status } = message.data;
      const activeRequest = usePlatformConnectStore.getState().activeRequest;

      if (activeRequest?.platform === platformId && status === "connected") {
        console.log("[PlatformConnectStore] Connection successful, dismissing modal");
        usePlatformConnectStore.getState().clearRequest();
      }
    }
  };

  window.addEventListener("gateway-broadcast", handleBroadcast);
}
