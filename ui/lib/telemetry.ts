/**
 * Amplitude Telemetry for Renderer (UI)
 * Events-only tracking (no session replay for privacy)
 */

import * as amplitude from "@amplitude/analytics-browser";
import type {
  AmplitudeEvents,
  BaseEventProperties,
} from "../../core/telemetry/events";

let isInitialized = false;
let installId: string | null = null;

/**
 * Initialize Amplitude with event tracking only
 * Called once on app start if telemetry is enabled
 */
export async function initializeAmplitudeBrowser(
  anonymousInstallId: string,
  enabled: boolean,
  appVersion: string,
): Promise<void> {
  if (isInitialized) {
    console.warn("[Amplitude] Already initialized");
    return;
  }

  if (!enabled) {
    console.log("[Amplitude] Telemetry disabled");
    return;
  }

  if (!anonymousInstallId) {
    console.warn("[Amplitude] No install ID provided");
    return;
  }

  installId = anonymousInstallId;

  try {
    // Get server URL from environment or use default
    const serverUrl =
      import.meta.env.VITE_TELEMETRY_URL ||
      "https://dashboard.papr.ai/v1/telemetry/events";

    // Initialize Amplitude (events only, no session replay for privacy)
    amplitude.init(
      "paprwork-browser", // Client identifier (actual key on server)
      anonymousInstallId,
      {
        serverUrl,
        defaultTracking: {
          sessions: true,
          pageViews: false, // Electron app doesn't have page views
          formInteractions: true,
          fileDownloads: false,
        },
        // Privacy
        trackingOptions: {
          ipAddress: false, // Don't track IP
          language: true,
          platform: true,
        },
      },
    );

    isInitialized = true;
    console.log(
      `[Amplitude] Initialized with event tracking (ID: ${anonymousInstallId.substring(0, 8)}...)`,
    );

    // Set initial user properties
    const identify = new amplitude.Identify();
    identify.set("app_version", appVersion);
    identify.set("platform", window.navigator.platform);
    amplitude.identify(identify);
  } catch (error) {
    console.error("[Amplitude] Initialization failed:", error);
  }
}

/**
 * Track an event (renderer side)
 */
export function trackEvent(
  eventName: keyof typeof AmplitudeEvents | string,
  properties?: BaseEventProperties,
): void {
  if (!isInitialized) {
    return; // Silently skip if not initialized
  }

  try {
    amplitude.track(eventName, {
      ...properties,
      client: "paprwork-renderer",
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error("[Amplitude] Track event failed:", error);
  }
}

/**
 * Set user properties (persistent attributes)
 */
export function setUserProperties(
  properties: Record<string, unknown>,
): void {
  if (!isInitialized) {
    return;
  }

  try {
    const identify = new amplitude.Identify();
    Object.entries(properties).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        identify.set(key, value);
      }
    });
    amplitude.identify(identify);
  } catch (error) {
    console.error("[Amplitude] Set user properties failed:", error);
  }
}

/**
 * Increment a user property counter
 */
export function incrementUserProperty(propertyName: string, delta = 1): void {
  if (!isInitialized) {
    return;
  }

  try {
    const identify = new amplitude.Identify();
    identify.add(propertyName, delta);
    amplitude.identify(identify);
  } catch (error) {
    console.error("[Amplitude] Increment user property failed:", error);
  }
}

/**
 * Force flush events (useful before app quit)
 */
export async function flushEvents(): Promise<void> {
  if (!isInitialized) {
    return;
  }

  try {
    await amplitude.flush();
    console.log("[Amplitude] Events flushed");
  } catch (error) {
    console.error("[Amplitude] Flush failed:", error);
  }
}

/**
 * Shutdown (clean up on app quit)
 */
export async function shutdownAmplitude(): Promise<void> {
  if (!isInitialized) {
    return;
  }

  try {
    await amplitude.flush();
    isInitialized = false;
    installId = null;
    console.log("[Amplitude] Shutdown complete");
  } catch (error) {
    console.error("[Amplitude] Shutdown failed:", error);
  }
}
