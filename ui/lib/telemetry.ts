/**
 * Renderer telemetry: POST same-origin to the gateway → Papr proxy → Amplitude.
 * Avoids @amplitude/analytics-browser (CORS + wrong wire format for our proxy).
 */

import type {
  AmplitudeEvents,
  BaseEventProperties,
} from "../../src/core/telemetry/events";
import { mergeTelemetryEnvelope } from "../../src/core/telemetry/telemetryProductContext";

let isInitialized = false;
let initPromise: Promise<void> | null = null;
let installId: string | null = null;
let paprUserIdCached: string | null = null;
let appVersionCached = "";
let httpBase = "";

const PENDING_EVENT_MAX = 100;

type PendingTelemetryEvent = {
  event_name: string;
  properties?: Record<string, unknown>;
  timestamp: number;
};

const pendingEvents: PendingTelemetryEvent[] = [];

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

export function resolveRendererPlatform(): "darwin" | "win32" | "linux" {
  if (typeof navigator === "undefined") {
    return "linux";
  }
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("mac") || platform.includes("darwin")) {
    return "darwin";
  }
  if (platform.includes("win")) {
    return "win32";
  }
  return "linux";
}

function buildRendererEventProperties(
  properties?: Record<string, unknown>,
): Record<string, unknown> {
  return mergeTelemetryEnvelope(
    {
      ...(properties ?? {}),
      client: "paprwork-renderer",
      app_version: appVersionCached,
      platform: resolveRendererPlatform(),
    },
    { isPackaged: import.meta.env.PROD },
  );
}

function enqueuePendingEvent(event: PendingTelemetryEvent): void {
  if (pendingEvents.length >= PENDING_EVENT_MAX) {
    pendingEvents.shift();
  }
  pendingEvents.push(event);
}

async function flushPendingEvents(): Promise<void> {
  if (!isInitialized || !installId || pendingEvents.length === 0) {
    return;
  }
  const batch = pendingEvents.splice(0, pendingEvents.length);
  await postEvents(batch);
}

/**
 * Initialize renderer telemetry (proxy path only).
 */
export async function initializeAmplitudeBrowser(
  anonymousInstallId: string,
  enabled: boolean,
  appVersion: string,
  paprUserId?: string,
): Promise<void> {
  if (!enabled) {
    console.log("[Telemetry] Renderer: disabled");
    pendingEvents.length = 0;
    return;
  }
  if (!anonymousInstallId) {
    console.warn("[Telemetry] Renderer: no install id");
    return;
  }
  if (isInitialized) {
    setTelemetryPaprUserId(paprUserId ?? null);
    await flushPendingEvents();
    return;
  }
  if (initPromise) {
    await initPromise;
    await flushPendingEvents();
    return;
  }

  initPromise = (async () => {
    try {
      installId = anonymousInstallId;
      paprUserIdCached = paprUserId ?? null;
      appVersionCached = appVersion;
      httpBase = resolveHttpBase();
      isInitialized = true;
      console.log(
        `[Telemetry] Renderer proxy → ${httpBase}/api/telemetry/events` +
          (paprUserId ? ` (identified: ${paprUserId.substring(0, 8)}…)` : " (anonymous)"),
      );
      await flushPendingEvents();
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
    const userId = paprUserIdCached || installId;
    const response = await fetch(`${httpBase}/api/telemetry/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        anonymous_id: installId,
        papr_account_id: paprUserIdCached ?? undefined,
        events: events.map((e) => ({
          event_name: e.event_name,
          properties: {
            ...buildRendererEventProperties(e.properties),
            ...(paprUserIdCached ? { papr_account_id: paprUserIdCached } : {}),
          },
          user_id: userId,
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
 * Update Papr user ID after login/logout without re-initializing telemetry.
 */
export function setTelemetryPaprUserId(paprUserId: string | null): void {
  const next = paprUserId?.trim() || null;
  if (next === paprUserIdCached) {
    return;
  }
  paprUserIdCached = next;
  console.log(
    next
      ? `[Telemetry] Identified user: ${next.substring(0, 8)}…`
      : "[Telemetry] Reverted to anonymous tracking",
  );
}

/**
 * Track an event (renderer side). Events before init are queued and flushed once ready.
 */
export function trackEvent(
  eventName: keyof typeof AmplitudeEvents | string,
  properties?: BaseEventProperties,
): void {
  const payload = properties as Record<string, unknown> | undefined;
  const event: PendingTelemetryEvent = {
    event_name: String(eventName),
    properties: payload,
    timestamp: Date.now(),
  };

  if (!isInitialized || !installId) {
    enqueuePendingEvent(event);
    return;
  }

  void postEvents([event]);
}

/**
 * Best-effort user properties (forwarded as a named event for the proxy).
 */
export function setUserProperties(properties: Record<string, unknown>): void {
  trackEvent("paprwork_renderer_user_properties", properties as BaseEventProperties);
}

export function incrementUserProperty(propertyName: string, delta = 1): void {
  trackEvent("paprwork_renderer_counter", {
    counter_key: propertyName,
    counter_delta: delta,
  } as unknown as BaseEventProperties);
}

export async function flushEvents(): Promise<void> {
  await flushPendingEvents();
}

export async function shutdownAmplitude(): Promise<void> {
  isInitialized = false;
  installId = null;
  paprUserIdCached = null;
  httpBase = "";
  pendingEvents.length = 0;
}

/** Test-only reset for renderer telemetry state. */
export function __resetTelemetryForTests(): void {
  isInitialized = false;
  initPromise = null;
  installId = null;
  paprUserIdCached = null;
  appVersionCached = "";
  httpBase = "";
  pendingEvents.length = 0;
}
