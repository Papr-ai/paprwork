/** Reasons a stream was intentionally stopped (not a provider/API failure). */
export const STREAM_REPLACED_REASON = "Replaced by new message";
export const STREAM_STOPPED_BY_USER_REASON = "Stopped by user";
export const STREAM_STOPPED_REASON = "Stream stopped";

const EXPECTED_STREAM_CANCELLATION_REASONS = new Set([
  STREAM_REPLACED_REASON,
  STREAM_STOPPED_BY_USER_REASON,
  STREAM_STOPPED_REASON,
  "aborted",
]);

export function isExpectedStreamCancellation(reason: string): boolean {
  const normalized = reason.trim();
  if (EXPECTED_STREAM_CANCELLATION_REASONS.has(normalized)) {
    return true;
  }
  const lower = normalized.toLowerCase();
  return (
    lower.includes("aborted") ||
    lower.includes("abort") ||
    lower.includes("the user aborted")
  );
}

/**
 * Provider closed the HTTP stream unexpectedly (timeout, proxy idle close, socket
 * reset). Unlike user-initiated stop, these should auto-continue the turn.
 */
export function isRecoverableProviderStreamDrop(reason: string): boolean {
  const normalized = reason.trim();
  const lower = normalized.toLowerCase();

  if (normalized === "terminated" || normalized === "socket hang up") {
    return true;
  }
  if (lower.includes("econnreset") || lower.includes("stream_ended_early")) {
    return true;
  }
  if (
    lower.includes("connect timeout") ||
    lower.includes("connection timed out") ||
    lower.includes("headers timeout") ||
    lower.includes("body timeout") ||
    lower.includes("request timed out") ||
    lower.includes("api connection timeout")
  ) {
    return true;
  }
  return false;
}
