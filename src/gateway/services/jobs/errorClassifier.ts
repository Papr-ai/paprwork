export type ErrorType = "transient" | "permanent";

/**
 * Classifies errors as transient (retryable) or permanent (should not retry).
 * 
 * Transient errors:
 * - Rate limits (429, "too many requests")
 * - Provider overloads (529, "overloaded")
 * - Network errors (timeout, ECONNRESET, ETIMEDOUT)
 * - Server errors (5xx)
 * 
 * Permanent errors:
 * - Auth failures (401, "unauthorized", "invalid api key")
 * - Forbidden (403)
 * - Not found (404)
 * - Validation errors
 */
export function classifyError(error: unknown): ErrorType {
  const msg = (error as Error).message?.toLowerCase() ?? "";
  const code = (error as any).code;

  // Transient (retryable) errors
  if (msg.includes("rate limit") || msg.includes("429")) return "transient";
  if (msg.includes("too many requests")) return "transient";
  if (msg.includes("overloaded") || msg.includes("529")) return "transient";
  if (msg.includes("timeout") || msg.includes("timed out")) return "transient";
  if (msg.includes("econnreset") || msg.includes("connection reset"))
    return "transient";
  if (msg.includes("econnrefused") || msg.includes("connection refused"))
    return "transient";
  if (msg.includes("network error") || msg.includes("fetch failed"))
    return "transient";
  if (code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ECONNREFUSED")
    return "transient";
  
  // 5xx server errors are transient
  if (/5\d{2}/.test(msg)) return "transient";

  // Permanent (non-retryable) errors
  if (msg.includes("unauthorized") || msg.includes("401")) return "permanent";
  if (msg.includes("invalid api key") || msg.includes("invalid_api_key"))
    return "permanent";
  if (msg.includes("authentication failed")) return "permanent";
  if (msg.includes("forbidden") || msg.includes("403")) return "permanent";
  if (msg.includes("not found") || msg.includes("404")) return "permanent";
  if (msg.includes("bad request") || msg.includes("400")) return "permanent";
  if (msg.includes("validation error") || msg.includes("invalid input"))
    return "permanent";

  // Default to transient (safer to retry than give up)
  return "transient";
}

/**
 * Returns a human-readable reason for the error classification.
 */
export function getErrorClassificationReason(error: unknown): string {
  const msg = (error as Error).message?.toLowerCase() ?? "";
  const code = (error as any).code;

  if (msg.includes("rate limit") || msg.includes("429"))
    return "Rate limit exceeded (will retry with backoff)";
  if (msg.includes("overloaded") || msg.includes("529"))
    return "Provider overloaded (will retry)";
  if (msg.includes("timeout") || msg.includes("timed out"))
    return "Request timed out (will retry)";
  if (code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ECONNREFUSED")
    return "Network error (will retry)";
  if (/5\d{2}/.test(msg)) return "Server error (will retry)";

  if (msg.includes("unauthorized") || msg.includes("401"))
    return "Authentication failed (permanent error, no retry)";
  if (msg.includes("invalid api key"))
    return "Invalid API key (permanent error, no retry)";
  if (msg.includes("forbidden") || msg.includes("403"))
    return "Forbidden (permanent error, no retry)";
  if (msg.includes("validation error"))
    return "Validation error (permanent error, no retry)";

  return "Unknown error (will retry)";
}
