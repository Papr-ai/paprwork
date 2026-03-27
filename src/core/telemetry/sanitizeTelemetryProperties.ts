/**
 * Strip PII-ish keys and non-primitive values from telemetry event properties.
 * Aligned with Papr Memory OSS telemetry anonymization.
 */

const SENSITIVE_SUBSTRINGS = [
  "content",
  "query",
  "text",
  "message",
  "body",
  "email",
  "username",
  "password",
  "token",
  "key",
  "secret",
  "ip",
  "ip_address",
  "ipv4",
  "ipv6",
  "path",
  "file_path",
  "filename",
  "file_name",
  "user_id",
  "userid",
  "objectid",
  "session_token",
  "api_key",
  "sessiontoken",
] as const;

function keyLooksSensitive(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_SUBSTRINGS.some((s) => lower.includes(s));
}

export function sanitizeTelemetryProperties(
  properties: Record<string, unknown>,
): Record<string, number | string | boolean> {
  const safe: Record<string, number | string | boolean> = {};

  for (const [key, value] of Object.entries(properties)) {
    if (keyLooksSensitive(key)) {
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      safe[key] = value;
    } else if (Array.isArray(value)) {
      safe[`${key}_count`] = value.length;
    }
  }

  return safe;
}
