/**
 * Which connection state the indicator should report.
 *
 * Extracted from `GatewayClient.getConnectionState()` because the decision has
 * a trap in it. The state used to be derived from `reconnectAttempts > 0`,
 * which reads "are we deliberately re-establishing a connection" off the
 * backoff counter — and the `system:resume` handler resets that counter to zero
 * so a long sleep does not leave the app waiting out a 30s backoff. The one
 * path that *knows* it is reconnecting therefore reported `disconnected`, whose
 * label is "Connection lost — check Gateway", telling the user to go and check
 * a gateway that was fine and about to be reconnected.
 *
 * So the counter answers "how many attempts have we made", not "are we
 * reconnecting". A connect in flight after a previous success is a reconnect
 * whatever the counter says.
 */

export type GatewayConnectionState =
  | "connected"
  | "degraded"
  | "reconnecting"
  | "disconnected";

/**
 * `WebSocket.CONNECTING` / `WebSocket.OPEN` as numbers.
 *
 * Restated rather than read off the global so this module is testable outside a
 * DOM environment. Fixed by the WHATWG spec, so they cannot drift.
 */
export const WS_CONNECTING = 0;
export const WS_OPEN = 1;

export interface GatewayConnectionStateInput {
  /** `WebSocket.readyState`, or null when no socket has been created. */
  readyState: number | null;
  /** Heartbeats are being missed but the budget is not yet spent. */
  degraded: boolean;
  reconnectAttempts: number;
  maxReconnectAttempts: number;
  /** Whether a socket has ever reached `onopen` in this session. */
  hasEverConnected: boolean;
}

export function resolveGatewayConnectionState(
  input: GatewayConnectionStateInput,
): GatewayConnectionState {
  if (input.readyState === WS_OPEN) {
    return input.degraded ? "degraded" : "connected";
  }

  // Given up. Reported as lost rather than reconnecting, because nothing
  // further will be attempted.
  if (input.reconnectAttempts >= input.maxReconnectAttempts) {
    return "disconnected";
  }

  if (input.reconnectAttempts > 0) {
    return "reconnecting";
  }

  // Counter is zero but a connect is in flight. Only a reconnect if we have
  // held a connection before — at first boot this is the initial connect, and
  // reporting it as `disconnected` is what lets the indicator show the
  // supervisor's "Gateway starting..." message through the 60s cold start.
  if (input.hasEverConnected && input.readyState === WS_CONNECTING) {
    return "reconnecting";
  }

  return "disconnected";
}
