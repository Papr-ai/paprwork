/**
 * Platform Connect Store
 *
 * Zustand store for platform connection requests from the agent.
 * When the agent needs a platform connected, it sends a request
 * that triggers the branded connection modal.
 */

import { create } from "zustand";
import { gateway } from "../../src/lib/gateway";

/** Built-in social platform id (custom sites use `site-*` strings). */
export type PlatformId =
  | "linkedin"
  | "instagram"
  | "reddit"
  | "facebook"
  | "tiktok"
  | "twitter"
  | "telegram";

export interface PlatformConnectRequest {
  /** Built-in id or registered custom site id (e.g. site-mail-google-com). */
  platform: string;
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

async function isPlatformAlreadyConnected(platformId: string): Promise<boolean> {
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
      const rawId = message.data?.platformId;
      const platformId =
        typeof rawId === "string" ? rawId.trim() : "";
      if (!platformId) {
        console.warn(
          "[PlatformConnectStore] Ignoring connect request with no platformId",
        );
        return;
      }
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
        platformId: string;
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

  // "Connect Reddit" on a published app's setup page: papr:// deep link (browser)
  // or postMessage from the app's preview iframe. Same modal the agent opens.
  window.addEventListener("papr-platform-connect", (event: Event) => {
    const platform = (event as CustomEvent<{ platform?: string }>).detail?.platform;
    if (typeof platform === "string" && platform.trim()) openPlatformConnect(platform.trim());
  });
  // Setup pages inside app previews that are waiting on a sign-in.
  const waitingFrames = new Map<string, Set<MessageEventSource>>();
  const notifyConnected = (platform: string) => {
    for (const source of waitingFrames.get(platform) ?? []) {
      (source as Window).postMessage({ type: "papr-platform-connected", platform }, "*");
    }
    waitingFrames.delete(platform);
  };
  window.addEventListener("gateway-broadcast", (event: Event) => {
    const message = (event as CustomEvent).detail;
    if (message?.type !== "platform:status-changed" || message.data?.status !== "connected") return;
    if (typeof message.data.platformId === "string") notifyConnected(message.data.platformId);
  });
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.data?.type !== "papr-connect-platform") return;
    const platform = event.data.platform;
    if (typeof platform !== "string" || !/^[a-z][a-z0-9-]{1,60}$/.test(platform)) return;
    if (event.source) {
      const set = waitingFrames.get(platform) ?? new Set<MessageEventSource>();
      set.add(event.source);
      waitingFrames.set(platform, set);
    }
    void (async () => {
      // Already signed in on this computer: tell the page right away.
      if (await isPlatformAlreadyConnected(platform)) notifyConnected(platform);
      else openPlatformConnect(platform);
    })();
  });
}

/** Open the Connected Platforms sign-in modal (no-op when already connected). */
export function openPlatformConnect(platformId: string, reason?: string): void {
  void (async () => {
    if (await isPlatformAlreadyConnected(platformId)) return;
    usePlatformConnectStore.getState().setActiveRequest({
      platform: platformId,
      reason: reason ?? "An app you opened on the web needs this sign-in.",
      requestId: crypto.randomUUID(),
    });
  })();
}
