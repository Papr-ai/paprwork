/**
 * Strip PII-ish keys and non-primitive values from telemetry event properties.
 *
 * Uses EXACT key matching (not substring) to avoid blocking useful telemetry
 * fields like "failure_hint", "job_name", "model", etc.
 */

const BLOCKED_KEYS = new Set([
  "email",
  "username",
  "password",
  "token",
  "secret",
  "api_key",
  "apikey",
  "api_secret",
  "ip_address",
  "ipv4",
  "ipv6",
  "session_token",
  "sessiontoken",
  "access_token",
  "refresh_token",
  "authorization",
  "cookie",
  "user_id",
  "userid",
  "objectid",
  "ssn",
  "credit_card",
  "phone",
  "address",
  "body",
  "query",
]);

export function sanitizeTelemetryProperties(
  properties: Record<string, unknown>,
): Record<string, number | string | boolean> {
  const safe: Record<string, number | string | boolean> = {};

  for (const [key, value] of Object.entries(properties)) {
    if (BLOCKED_KEYS.has(key.toLowerCase())) {
      continue;
    }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      safe[key] = value;
    } else if (Array.isArray(value)) {
      safe[`${key}_count`] = value.length;
    }
  }

  return safe;
}
