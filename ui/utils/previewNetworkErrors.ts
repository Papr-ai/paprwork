/** Network / gateway errors that are expected while the local gateway is still starting. */

const TRANSIENT_NETWORK_PATTERNS: readonly RegExp[] = [
  /^failed to fetch$/i,
  /^networkerror/i,
  /load failed/i,
  /network request failed/i,
  /fetch failed/i,
  /503\b.*service unavailable/i,
  /gateway is starting/i,
  /still starting/i,
];

export function isTransientMiniAppNetworkError(message: string): boolean {
  const inner = message.trim();
  if (inner.length === 0) {
    return false;
  }
  return TRANSIENT_NETWORK_PATTERNS.some((pattern) => pattern.test(inner));
}

export function shouldSuppressMiniAppRuntimeBanner(input: {
  message: string;
  waitingForGateway: boolean;
  gatewaySupervisorStarting: boolean;
  gatewaySupervisorReady: boolean;
}): boolean {
  if (input.waitingForGateway) {
    return true;
  }
  if (
    !input.gatewaySupervisorReady &&
    (input.gatewaySupervisorStarting ||
      isTransientMiniAppNetworkError(input.message))
  ) {
    return true;
  }
  return isTransientMiniAppNetworkError(input.message);
}
