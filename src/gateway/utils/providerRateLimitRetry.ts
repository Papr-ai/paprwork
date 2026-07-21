const MAX_BACKOFF_MS = 60_000;

/** Automatic silent retries before surfacing the Resume UI (2 retries = 3 total attempts). */
export const MAX_PROVIDER_RATE_LIMIT_RETRIES = 2;

export const RATE_LIMIT_EXHAUSTED_ERROR_CODE = "rate_limit_exhausted";

export function createRateLimitExhaustedError(): {
  type: "stream_pause";
  code: typeof RATE_LIMIT_EXHAUSTED_ERROR_CODE;
  message: string;
} {
  return {
    type: "stream_pause",
    code: RATE_LIMIT_EXHAUSTED_ERROR_CODE,
    message:
      "The AI provider is rate limited. Tap Resume when ready to continue.",
  };
}

function collectErrorStrings(error: unknown, depth = 0): string[] {
  if (depth > 4 || error == null) return [];
  if (typeof error === "string") return [error];

  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.message);
    if (error.name) parts.push(error.name);
  }

  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const key of ["message", "type", "errorMessage", "code", "reason"]) {
      const value = record[key];
      if (typeof value === "string") parts.push(value);
    }
    if (typeof record.statusCode === "number") {
      parts.push(String(record.statusCode));
    }
    if (typeof record.responseBody === "string") {
      parts.push(record.responseBody);
    }
    if (typeof record.error === "object" && record.error !== null) {
      parts.push(...collectErrorStrings(record.error, depth + 1));
    }
    if (Array.isArray(record.errors)) {
      for (const nested of record.errors) {
        parts.push(...collectErrorStrings(nested, depth + 1));
      }
    }
    if (record.lastError !== undefined) {
      parts.push(...collectErrorStrings(record.lastError, depth + 1));
    }
  }

  return parts;
}

export function isProviderRateLimitError(error: unknown): boolean {
  const haystack = collectErrorStrings(error).join(" ").toLowerCase();
  return (
    haystack.includes("rate_limit") ||
    haystack.includes("rate limit") ||
    haystack.includes("rate limited") ||
    haystack.includes("429") ||
    haystack.includes("too many requests")
  );
}

export function isProviderOverloadError(error: unknown): boolean {
  const haystack = collectErrorStrings(error).join(" ").toLowerCase();
  return (
    haystack.includes("overloaded") ||
    haystack.includes("overloaded_error") ||
    haystack.includes("529")
  );
}

export function isRetryableProviderCapacityError(error: unknown): boolean {
  return isProviderRateLimitError(error) || isProviderOverloadError(error);
}

function parseRetryAfterSeconds(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;

  const direct = record.retryAfter ?? record["retry-after"];
  if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) {
    return direct;
  }
  if (typeof direct === "string" && direct.trim()) {
    const parsed = Number.parseFloat(direct);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }

  const headers = record.headers;
  if (typeof headers === "object" && headers !== null) {
    const headerRecord = headers as Record<string, unknown>;
    const headerValue =
      headerRecord["retry-after"] ?? headerRecord["Retry-After"];
    if (typeof headerValue === "string" && headerValue.trim()) {
      const parsed = Number.parseFloat(headerValue);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
  }

  if (typeof record.responseBody === "string") {
    try {
      const body = JSON.parse(record.responseBody) as Record<string, unknown>;
      const retryAfter = body.retry_after ?? body.retryAfter;
      if (typeof retryAfter === "number" && retryAfter >= 0) return retryAfter;
    } catch {
      // ignore malformed JSON
    }
  }

  return undefined;
}

export function computeRateLimitBackoffMs(
  attempt: number,
  error?: unknown,
): number {
  const retryAfterSec = error ? parseRetryAfterSeconds(error) : undefined;
  if (retryAfterSec != null) {
    return Math.min(Math.max(Math.ceil(retryAfterSec * 1000), 500), 120_000);
  }

  const exponential = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
  const jitter = Math.floor(Math.random() * exponential * 0.25);
  return exponential + jitter;
}


export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
