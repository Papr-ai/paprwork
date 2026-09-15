export type AppGetFailureKind = "not_found" | "gateway_busy" | "unknown";

/**
 * Retry policy for `app:get`. Sized against the ~60s the gateway supervisor
 * itself waits for a health probe, so a slow boot is outlasted rather than
 * reported as a missing app.
 */
export const APP_LOOKUP_MAX_ATTEMPTS = 12;
export const APP_LOOKUP_RETRY_MS = 2500;

/**
 * Verbatim from `ui/src/lib/gateway.ts` — these are the strings the transport
 * actually produces. "Gateway not connected" and "Gateway disconnected" are the
 * two most common ones during boot, and they fall outside the timeout wording,
 * so matching only on timeouts leaves the usual case classified as `unknown`
 * (no retry, generic copy). `papr_identity_unresolved` is the gateway telling us
 * it could not read the signed-in user yet, which is the same transient
 * condition wearing a different name.
 */
const GATEWAY_BUSY_PATTERN =
  /timed? ?out|gateway (?:not connected|disconnected|is still)|econnrefused|network error|fetch failed|papr_identity_unresolved|could not determine the signed-in papr user/i;

/**
 * Deliberately narrower than "mentions a namespace". A bare `namespace` token
 * also appears in transient identity errors ("the workspace is still
 * starting"), and reading one of those as "not here" latches a scoping claim
 * over a condition that clears itself in seconds. The two mistakes are not
 * symmetric: a wrong "not found" blanks a working app and tells the user
 * something false about their workspace, while a wrong "busy" costs a few
 * retries.
 */
const NOT_FOUND_PATTERN =
  /app not found|not in the current workspace|wrong workspace|not in this namespace|belongs to another namespace/i;

export function classifyAppGetFailure(
  errorMessage: string | undefined,
): AppGetFailureKind {
  const msg = errorMessage?.trim() ?? "";
  if (msg.length === 0) {
    return "unknown";
  }
  // Transport signals win: a gateway that never answered cannot be evidence
  // about where an app lives, whatever else the message happens to mention.
  if (GATEWAY_BUSY_PATTERN.test(msg)) {
    return "gateway_busy";
  }
  if (NOT_FOUND_PATTERN.test(msg)) {
    return "not_found";
  }
  return "unknown";
}

export function appGetFailureUserMessage(kind: AppGetFailureKind): string {
  switch (kind) {
    case "gateway_busy":
      return "Gateway is starting — this app will load when it is ready…";
    case "not_found":
      return "This app is not in the current workspace. Close this tab or switch back to the workspace where it lives.";
    default:
      return "Could not load this app right now. Try again in a moment.";
  }
}

export function resolveAppGetUserMessage(
  errorMessage: string | undefined,
): string {
  return appGetFailureUserMessage(classifyAppGetFailure(errorMessage));
}
