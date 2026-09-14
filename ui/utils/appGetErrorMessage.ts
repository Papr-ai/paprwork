export type AppGetFailureKind = "not_found" | "gateway_busy" | "unknown";

const GATEWAY_BUSY_PATTERN =
  /request timeout|gateway connection timeout|gateway is still|econnrefused|network error|fetch failed/i;

export function classifyAppGetFailure(
  errorMessage: string | undefined,
): AppGetFailureKind {
  const msg = errorMessage?.trim() ?? "";
  if (msg.length === 0) {
    return "unknown";
  }
  if (GATEWAY_BUSY_PATTERN.test(msg)) {
    return "gateway_busy";
  }
  if (/app not found|not in the current workspace|wrong workspace|namespace/i.test(msg)) {
    return "not_found";
  }
  return "unknown";
}

export function appGetFailureUserMessage(kind: AppGetFailureKind): string {
  switch (kind) {
    case "gateway_busy":
      return "The gateway is still starting or busy. Wait a moment and try again, or switch away from this tab and back.";
    case "not_found":
      return "This app is not in the current workspace. Close this tab or switch back to the workspace where it lives.";
    default:
      return "Could not load this app right now. Try again in a moment.";
  }
}

export function resolveAppGetUserMessage(errorMessage: string | undefined): string {
  return appGetFailureUserMessage(classifyAppGetFailure(errorMessage));
}
