/**
 * Renderer telemetry: POST same-origin to the gateway → Papr proxy → Amplitude.
 * Avoids @amplitude/analytics-browser (CORS + wrong wire format for our proxy).
 */

import type {
  AmplitudeEvents,
  BaseEventProperties,
} from "../../src/core/telemetry/events";

let isInitialized = false;
let initPromise: Promise<void> | null = null;
let installId: string | null = null;
let appVersionCached = "";
let httpBase = "";

function gatewayOrigin(): string {
  const host = import.meta.env.VITE_GATEWAY_HOST || "localhost";
  const port = import.meta.env.VITE_GATEWAY_PORT || "18789";
  return `http://${host}:${port}`;
}

function resolveHttpBase(): string {
  if (import.meta.env.DEV) {
    return gatewayOrigin();
  }
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return gatewayOrigin();
}

/**
 * Initialize renderer telemetry (proxy path only).
 */
export async function initializeAmplitudeBrowser(
  anonymousInstallId: string,
  enabled: boolean,
  appVersion: string,
): Promise<void> {
  if (!enabled) {
    console.log("[Telemetry] Renderer: disabled");
    return;
  }
  if (!anonymousInstallId) {
    console.warn("[Telemetry] Renderer: no install id");
    return;
  }
  if (isInitialized) {
    return;
  }
  if (initPromise) {
    await initPromise;
    return;
  }

  initPromise = (async () => {
    try {
      installId = anonymousInstallId;
      appVersionCached = appVersion;
      httpBase = resolveHttpBase();
      isInitialized = true;
      console.log(
        `[Telemetry] Renderer proxy → ${httpBase}/api/telemetry/events`,
      );
    } finally {
      initPromise = null;
    }
  })();

  await initPromise;
}

async function postEvents(
  events: Array<{
    event_name: string;
    properties?: Record<string, unknown>;
    timestamp?: number;
  }>,
): Promise<void> {
  if (!isInitialized || !installId || !httpBase) {
    return;
  }
  try {
    const response = await fetch(`${httpBase}/api/telemetry/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        anonymous_id: installId,
        events: events.map((e) => ({
          event_name: e.event_name,
          properties: e.properties ?? {},
          user_id: installId,
          timestamp: e.timestamp ?? Date.now(),
        })),
      }),
    });
    if (!response.ok && import.meta.env.DEV) {
      console.warn(
        "[Telemetry] Renderer POST failed:",
        response.status,
        await response.text().catch(() => ""),
      );
    }
  } catch (err) {
    if (import.meta.env.DEV) {
      console.warn("[Telemetry] Renderer POST error:", err);
    }
  }
}

/**
 * Track an event (renderer side).
 */
export function trackEvent(
  eventName: keyof typeof AmplitudeEvents | string,
  properties?: BaseEventProperties,
): void {
  if (!isInitialized || !installId) {
    return;
  }
  void postEvents([
    {
      event_name: String(eventName),
      properties: {
        ...(properties as Record<string, unknown> | undefined),
        client: "paprwork-renderer",
        app_version: appVersionCached,
      },
      timestamp: Date.now(),
    },
  ]);
}

/**
 * Best-effort user properties (forwarded as a named event for the proxy).
 */
export function setUserProperties(properties: Record<string, unknown>): void {
  if (!isInitialized || !installId) {
    return;
  }
  void postEvents([
    {
      event_name: "paprwork_renderer_user_properties",
      properties: {
        ...properties,
        client: "paprwork-renderer",
        app_version: appVersionCached,
      },
    },
  ]);
}

export function incrementUserProperty(propertyName: string, delta = 1): void {
  if (!isInitialized || !installId) {
    return;
  }
  void postEvents([
    {
      event_name: "paprwork_renderer_counter",
      properties: {
        counter_key: propertyName,
        counter_delta: delta,
        client: "paprwork-renderer",
        app_version: appVersionCached,
      },
    },
  ]);
}

export async function flushEvents(): Promise<void> {
  /* no client-side queue */
}

export async function shutdownAmplitude(): Promise<void> {
  isInitialized = false;
  installId = null;
  httpBase = "";
}
