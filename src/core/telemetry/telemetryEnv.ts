const DEFAULT_TELEMETRY_BASE = "https://memory.papr.ai";

/**
 * Explicit env override for telemetry. Undefined means "use app preference".
 */
export function parseTelemetryEnvOverride(): boolean | undefined {
  const raw = process.env.PAPRWORK_TELEMETRY_ENABLED;
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const v = raw.toLowerCase();
  if (v === "true" || v === "1" || v === "yes") {
    return true;
  }
  if (v === "false" || v === "0" || v === "no") {
    return false;
  }
  return undefined;
}

/**
 * Base URL for POST /v1/telemetry/events. Empty env disables sending.
 * Invalid scheme returns null.
 */
export function resolveTelemetryBaseUrl(): string | null {
  const raw = process.env.PAPRWORK_TELEMETRY_URL;
  if (raw !== undefined && raw.trim() === "") {
    return null;
  }
  const base = (raw ?? DEFAULT_TELEMETRY_BASE).trim().replace(/\/$/, "");
  if (!base.startsWith("http://") && !base.startsWith("https://")) {
    return null;
  }
  return base;
}

export function isTelemetrySendingEnabled(getUserPreference: () => boolean): boolean {
  const env = parseTelemetryEnvOverride();
  if (env === false) {
    return false;
  }
  if (env === true) {
    return true;
  }
  return getUserPreference();
}
