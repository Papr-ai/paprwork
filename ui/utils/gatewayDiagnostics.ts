/**
 * Local gateway perf snapshots for support (loopback only). Paths in strings are redacted.
 */

const HOME_PATH =
  /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|C:\\Users\\[^\\\s]+)(?:\/[^"\s]*)?/gi;

export function resolveGatewayHttpBase(): string {
  if (typeof import.meta !== "undefined" && import.meta.env?.VITE_GATEWAY_PORT) {
    const host = import.meta.env.VITE_GATEWAY_HOST || "localhost";
    const port = import.meta.env.VITE_GATEWAY_PORT || "18789";
    return `http://${host}:${port}`;
  }
  return "http://localhost:18789";
}

export function redactDiagnosticsString(text: string): string {
  return text.replace(HOME_PATH, "[HOME]");
}

export function redactDiagnosticsValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactDiagnosticsString(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactDiagnosticsValue);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = redactDiagnosticsValue(entry);
    }
    return out;
  }
  return value;
}

export const DIAGNOSTICS_FETCH_TIMEOUT_MS = 8_000;

const DIAGNOSTICS_PATHS = [
  "/health",
  "/api/workspace/switch-status",
  "/api/debug/gateway-background",
  "/api/debug/turso-worker-timings",
  "/api/debug/replica-read-phases",
] as const;

export type GatewayDiagnosticsPath = (typeof DIAGNOSTICS_PATHS)[number];

export interface GatewayDiagnosticsEndpointResult {
  ok: boolean;
  status: number;
  body: unknown;
}

export interface GatewayDiagnosticsBundle {
  collectedAt: string;
  gatewayBaseUrl: string;
  fetchTimeoutMs: number;
  endpoints: Record<GatewayDiagnosticsPath, GatewayDiagnosticsEndpointResult>;
}

export async function fetchDiagnosticsEndpoint(
  gatewayBaseUrl: string,
  path: GatewayDiagnosticsPath,
  timeoutMs: number = DIAGNOSTICS_FETCH_TIMEOUT_MS,
): Promise<GatewayDiagnosticsEndpointResult> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${gatewayBaseUrl}${path}`, {
      signal: controller.signal,
    });
    let body: unknown;
    try {
      body = redactDiagnosticsValue(await res.json());
    } catch {
      body = { parseError: true, status: res.status };
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === "AbortError"
          ? `Timed out after ${timeoutMs}ms`
          : err.message
        : String(err);
    return {
      ok: false,
      status: 0,
      body: {
        fetchError: redactDiagnosticsString(message),
      },
    };
  } finally {
    window.clearTimeout(timer);
  }
}

export function diagnosticsBundleHasUsableData(
  bundle: GatewayDiagnosticsBundle,
): boolean {
  return Object.values(bundle.endpoints).some(
    (entry) => entry.status > 0 || entry.ok,
  );
}

export async function fetchGatewayDiagnosticsBundle(): Promise<GatewayDiagnosticsBundle> {
  const gatewayBaseUrl = resolveGatewayHttpBase();
  const endpoints = {} as GatewayDiagnosticsBundle["endpoints"];

  await Promise.all(
    DIAGNOSTICS_PATHS.map(async (path) => {
      endpoints[path] = await fetchDiagnosticsEndpoint(
        gatewayBaseUrl,
        path,
        DIAGNOSTICS_FETCH_TIMEOUT_MS,
      );
    }),
  );

  return {
    collectedAt: new Date().toISOString(),
    gatewayBaseUrl,
    fetchTimeoutMs: DIAGNOSTICS_FETCH_TIMEOUT_MS,
    endpoints,
  };
}
