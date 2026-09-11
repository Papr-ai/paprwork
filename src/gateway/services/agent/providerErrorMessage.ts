/**
 * Recovering the provider's own error message.
 *
 * The AI SDK's `APICallError` carries the provider's response in two places
 * (`responseBody`, the raw JSON string, and `data`, the parsed form) while
 * leaving `message` an empty string for whole classes of error. Formatting on
 * `message` alone therefore produced "API error (400): " — a status code and
 * nothing else — while the response body held the one sentence that told the
 * user what had happened and when it would stop.
 *
 * So read the body first and fall back to `message`, never the other way
 * round: the body is the provider speaking about this specific request, and
 * `message` is the SDK's summary of it.
 */

export interface ProviderErrorPayload {
  /** Provider's machine-readable error type, e.g. "invalid_request_error". */
  type?: string;
  /** Provider's human-readable sentence. */
  message?: string;
}

function readPayloadShape(value: unknown): ProviderErrorPayload | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const error = (value as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null) return undefined;

  const shape = error as Record<string, unknown>;
  const type = typeof shape.type === "string" ? shape.type : undefined;
  const message =
    typeof shape.message === "string" && shape.message.trim().length > 0
      ? shape.message
      : undefined;

  if (!type && !message) return undefined;
  return { ...(type ? { type } : {}), ...(message ? { message } : {}) };
}

/**
 * Pull the provider's error type and message out of an SDK error.
 *
 * Prefers `data` (already parsed) and falls back to parsing `responseBody`.
 */
export function extractProviderErrorPayload(
  error: unknown,
): ProviderErrorPayload | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const errorObj = error as Record<string, unknown>;

  const fromData = readPayloadShape(errorObj.data);
  if (fromData) return fromData;

  if (typeof errorObj.responseBody === "string") {
    try {
      return readPayloadShape(JSON.parse(errorObj.responseBody));
    } catch {
      // Not JSON — nothing to recover.
    }
  }

  return undefined;
}

/**
 * A spend cap is not a rate limit.
 *
 * Anthropic reports an exhausted usage limit as `400 invalid_request_error` on
 * some paths and as `429 rate_limit_error` on others, so the status code
 * cannot tell a spend cap from a burst limit — only the sentence can. "Wait a
 * moment and try again" is wrong advice for a limit that resets on a date. It
 * is not `402` either: the account has credit, someone has capped how much of
 * it this workspace may spend. That distinction decides where the user has to
 * go, so it is worth detecting on its own.
 *
 * Callers must consult this — or `detectProviderQuotaExhaustion`, which also
 * defers to transient markers and carries the reset time — *before* branching
 * on the status code, or a 429 branch will answer for both conditions.
 */
export function isUsageLimitError(payload: ProviderErrorPayload): boolean {
  const message = payload.message?.toLowerCase();
  if (!message) return false;

  // Deliberately not matching "credit balance too low": that is a 402 with its
  // own established message telling the user to add credits, which is different
  // advice from raising a cap.
  return (
    message.includes("usage limit") ||
    message.includes("spend limit") ||
    message.includes("spending limit") ||
    message.includes("quota")
  );
}

/**
 * Which provider actually served this request.
 *
 * Taken from the request URL rather than threaded down from config: the URL is
 * what the call really went to, and it is already on the error.
 */
export function providerFromRequestUrl(
  url: string | undefined,
): string | undefined {
  if (!url) return undefined;

  if (
    url.includes("api.anthropic.com") ||
    url.includes("claude.com") ||
    url.includes("claude.ai")
  ) {
    return "anthropic";
  }
  if (url.includes("openai.com")) return "openai";
  if (
    url.includes("generativelanguage.googleapis.com") ||
    url.includes("aistudio.google")
  ) {
    return "google";
  }

  return undefined;
}

/** "2026-10-01 at 00:00 UTC" out of the provider's sentence, when present. */
function extractRegainDate(message: string): string | undefined {
  const match = message.match(
    /regain access on ([0-9]{4}-[0-9]{2}-[0-9]{2}(?: at [^.]*)?)/i,
  );
  return match?.[1]?.trim();
}

/**
 * Where to go to fix a limit, per provider.
 *
 * Only providers whose console we can name confidently get a link; the rest get
 * the provider's own sentence, which is still far better than a bare status.
 */
function limitFixHint(provider: string | undefined): string | undefined {
  switch (provider) {
    case "anthropic":
      return "Raise or remove the cap in the Anthropic Console under Settings → Limits (https://console.anthropic.com/settings/limits).";
    case "openai":
      return "Raise or remove the cap in the OpenAI dashboard under Settings → Limits (https://platform.openai.com/settings/organization/limits).";
    case "google":
      return "Review your quota in Google AI Studio (https://aistudio.google.com/app/apikey).";
    default:
      return undefined;
  }
}

/**
 * Turn a provider limit error into something the user can act on.
 *
 * Returns null when this is not a limit error, so callers keep their existing
 * handling for everything else.
 */
export function describeUsageLimitError(
  payload: ProviderErrorPayload,
  provider?: string,
): string | null {
  if (!isUsageLimitError(payload) || !payload.message) return null;

  const parts = ["You have reached your API usage limit for this provider."];

  const regainDate = extractRegainDate(payload.message);
  if (regainDate) {
    parts.push(`Access returns on ${regainDate}.`);
  }

  const hint = limitFixHint(provider);
  if (hint) {
    parts.push(hint);
  }

  parts.push(
    "You can also switch to a different model in the composer to keep working now.",
  );

  return parts.join(" ");
}

/**
 * The AI SDK's `NoOutputGeneratedError`, which reports a consequence.
 *
 * It is raised in `streamText`'s flush when no step was recorded — the SDK's
 * own comment there reads "no steps recorded (e.g. in error scenario)". So it
 * is what a failed request looks like from the outside, never the reason for
 * one, and it arrives *after* the real error has already been reported. Left
 * alone it overwrites that error, which is how a response explaining an
 * exhausted usage limit reached the user as "No output generated."
 */
export function isNoOutputGeneratedError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const errorObj = error as Record<string, unknown>;

  const name = typeof errorObj.name === "string" ? errorObj.name : "";
  if (
    name === "AI_NoOutputGeneratedError" ||
    name === "NoOutputGeneratedError"
  ) {
    return true;
  }

  const message =
    typeof errorObj.message === "string" ? errorObj.message.toLowerCase() : "";
  return message.startsWith("no output generated");
}

/**
 * Format a provider error payload as a fallback message.
 *
 * Used when no specialised branch claims the error but the provider still told
 * us something useful.
 */
export function formatProviderErrorPayload(
  payload: ProviderErrorPayload,
  statusCode?: number,
): string | undefined {
  if (!payload.message) return undefined;
  return `API error${statusCode ? ` (${statusCode})` : ""}: ${payload.message}`;
}
