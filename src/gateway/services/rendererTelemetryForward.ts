import { resolveTelemetryBaseUrl } from "../../core/telemetry/telemetryEnv.js";
import { sanitizeTelemetryProperties } from "../../core/telemetry/sanitizeTelemetryProperties.js";
import { isTelemetrySendingEnabled } from "../../core/telemetry/telemetryEnv.js";
import { mergeTelemetryEnvelope } from "../../core/telemetry/telemetryProductContext.js";
import { getPaprUserId } from "../utils/paprUserId.js";
import { readActiveWorkspacePointer } from "../../core/utils/paprWorkspace.js";

const TELEMETRY_PATH = "/v1/telemetry/events";
const REQUEST_TIMEOUT_MS = 5000;
const MAX_EVENTS = 50;

function gatewayTelemetryPreference(): boolean {
  return process.env.PAPRWORK_TELEMETRY_ENABLED === "true";
}

function expectedAnonymousId(): string {
  return process.env.PAPRWORK_TELEMETRY_ANONYMOUS_ID?.trim() ?? "";
}

function appVersion(): string {
  return process.env.PAPRWORK_APP_VERSION?.trim() || "unknown";
}

export type RendererTelemetryReject = {
  ok: false;
  status: number;
  error: string;
};

export type RendererTelemetryPayload = {
  events: Array<{
    event_name: string;
    properties: Record<string, number | string | boolean>;
    user_id: string;
    timestamp: number;
  }>;
  anonymous_id: string;
  url: string;
};

export type RendererTelemetryPrepareResult =
  | RendererTelemetryReject
  | { ok: true; payload: RendererTelemetryPayload };

/** Sync validation + payload build — safe to run before responding to the client. */
export function prepareRendererTelemetry(
  rawBody: unknown,
): RendererTelemetryPrepareResult {
  if (!isTelemetrySendingEnabled(() => gatewayTelemetryPreference())) {
    return { ok: false, status: 403, error: "telemetry disabled" };
  }

  const anonId = expectedAnonymousId();
  if (!anonId) {
    return { ok: false, status: 503, error: "telemetry not configured" };
  }

  if (typeof rawBody !== "object" || rawBody === null) {
    return { ok: false, status: 400, error: "invalid body" };
  }

  const body = rawBody as {
    events?: unknown;
    anonymous_id?: unknown;
    papr_account_id?: unknown;
    papr_user_id?: unknown;
  };

  if (body.anonymous_id !== anonId) {
    return { ok: false, status: 403, error: "anonymous_id mismatch" };
  }

  const rendererAccountId =
    (typeof body.papr_account_id === "string" ? body.papr_account_id.trim() : "") ||
    (typeof body.papr_user_id === "string" ? body.papr_user_id.trim() : "");
  const effectivePaprUserId = rendererAccountId || getPaprUserId() || "";
  const workspacePointer = readActiveWorkspacePointer();

  if (!Array.isArray(body.events) || body.events.length === 0) {
    return { ok: false, status: 400, error: "events required" };
  }

  if (body.events.length > MAX_EVENTS) {
    return { ok: false, status: 400, error: "too many events" };
  }

  const base = resolveTelemetryBaseUrl();
  if (!base) {
    return { ok: false, status: 503, error: "telemetry url not configured" };
  }

  const outboundEvents: RendererTelemetryPayload["events"] = [];

  for (const raw of body.events) {
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, status: 400, error: "invalid event" };
    }
    const ev = raw as {
      event_name?: unknown;
      properties?: unknown;
      user_id?: unknown;
      timestamp?: unknown;
    };
    if (typeof ev.event_name !== "string" || !ev.event_name.trim()) {
      return { ok: false, status: 400, error: "invalid event_name" };
    }
    const evUserId = typeof ev.user_id === "string" ? ev.user_id : "";
    const allowedUserIds = [anonId];
    if (effectivePaprUserId) allowedUserIds.push(effectivePaprUserId);
    if (evUserId && !allowedUserIds.includes(evUserId)) {
      return { ok: false, status: 403, error: "user_id mismatch" };
    }

    const propsIn =
      ev.properties !== undefined &&
      typeof ev.properties === "object" &&
      ev.properties !== null
        ? (ev.properties as Record<string, unknown>)
        : {};

    const merged = mergeTelemetryEnvelope(
      {
        client: "paprwork-renderer",
        app_version: appVersion(),
        platform: process.platform,
        ...propsIn,
      },
      {
        paprAccountId: effectivePaprUserId,
        namespaceId: workspacePointer?.namespaceId,
        organizationId: workspacePointer?.organizationId,
      },
    );
    const safeProps = sanitizeTelemetryProperties(merged);

    const ts =
      typeof ev.timestamp === "number" && Number.isFinite(ev.timestamp)
        ? ev.timestamp
        : Date.now();

    const outUserId = effectivePaprUserId || anonId;
    outboundEvents.push({
      event_name: ev.event_name,
      properties: safeProps,
      user_id: outUserId,
      timestamp: ts,
    });
  }

  return {
    ok: true,
    payload: {
      events: outboundEvents,
      anonymous_id: anonId,
      url: `${base}${TELEMETRY_PATH}`,
    },
  };
}

/** Network forward only — run off the HTTP hot path. */
export async function sendPreparedRendererTelemetry(
  payload: RendererTelemetryPayload,
): Promise<{ status: number; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(payload.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: payload.events,
        anonymous_id: payload.anonymous_id,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = `upstream ${response.status}`;
      console.warn(`[Telemetry] Renderer forward failed: ${detail}`);
      return { status: 502, error: detail };
    }
    return { status: 204 };
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? "timeout"
        : err instanceof Error
          ? err.message
          : "network error";
    console.warn(`[Telemetry] Renderer forward failed: ${reason}`);
    return { status: 502, error: `forward failed: ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validates renderer POST body and forwards to Papr telemetry proxy (same wire
 * format as TelemetryClient). Avoids browser CORS by keeping requests same-origin
 * to the gateway.
 */
export async function forwardRendererTelemetry(
  rawBody: unknown,
): Promise<{ status: number; error?: string }> {
  const prepared = prepareRendererTelemetry(rawBody);
  if (!prepared.ok) {
    return { status: prepared.status, error: prepared.error };
  }
  return sendPreparedRendererTelemetry(prepared.payload);
}
