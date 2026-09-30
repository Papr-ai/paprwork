/**
 * One connection state for a provider card, derived from every signal we have.
 *
 * The card used to render three signals independently — a badge on the provider
 * card (does a key row exist), a badge on the OAuth panel (is a token stored),
 * and an expiry line (when does it lapse) — and nothing reconciled them. They
 * could each be right on their own terms and still combine into a lie: an
 * expired Claude token showed "OAuth", "Connected" and "Expired" at once, two
 * of them green, while requests were quietly being served by the platform API
 * key instead. Deriving one state in one place is what makes that impossible.
 */

export type ProviderConnectionState =
  /** Card is in API-key mode; OAuth is deliberately unused. */
  | { kind: "api_key_mode"; configured: boolean }
  /** No OAuth token stored. */
  | { kind: "disconnected" }
  /** Token stored and usable — either live, or expired but renewable. */
  | { kind: "connected" }
  /** Token stored but cannot authenticate. Needs the user. */
  | {
      kind: "needs_signin";
      /**
       * `rejected` is observed (a turn came back 401), `expired` is derived
       * from the stored expiry. Both mean unusable; they differ only in how
       * we found out, which is worth saying because a rejection can happen
       * while the clock still looks fine.
       */
      reason: "expired" | "rejected";
      /**
       * A real platform API key is present, so requests keep succeeding
       * against a separate account with its own billing and caps rather than
       * failing. Silence here is what made a subscription at 11% usage report
       * that its limits were exhausted.
       */
      fallsBackToApiKey: boolean;
    };

export interface ProviderConnectionInputs {
  /** Which credential the agent actually runs on, persisted in main. */
  mode: "oauth" | "apiKey";
  /** A stored key the user supplied, excluding the synced OAuth token. */
  platformApiKeyConfigured: boolean;
  status: {
    connected: boolean;
    isExpired?: boolean;
    /** Whether the stored refresh token can mint a new access token. */
    canRenew?: boolean;
  };
  /** A turn failed with 401 since the last reconnect. */
  authRejected: boolean;
}

export function deriveProviderConnectionState(
  inputs: ProviderConnectionInputs,
): ProviderConnectionState {
  const { mode, platformApiKeyConfigured, status, authRejected } = inputs;

  if (mode === "apiKey") {
    return { kind: "api_key_mode", configured: platformApiKeyConfigured };
  }

  if (!status.connected) return { kind: "disconnected" };

  // Observed rejection outranks the clock: the provider refusing the token is
  // stronger evidence than our own record of when we thought it lapsed.
  if (authRejected) {
    return {
      kind: "needs_signin",
      reason: "rejected",
      fallsBackToApiKey: platformApiKeyConfigured,
    };
  }

  // Expired but renewable is not a problem to show anyone — the next request
  // refreshes it. Only an expiry with no way back needs the user.
  if (status.isExpired === true && status.canRenew !== true) {
    return {
      kind: "needs_signin",
      reason: "expired",
      fallsBackToApiKey: platformApiKeyConfigured,
    };
  }

  return { kind: "connected" };
}

/**
 * Whether the state may be shown in the affirmative (green). Kept as its own
 * function so the several places that render a badge cannot drift on it.
 */
export function isHealthyConnection(state: ProviderConnectionState): boolean {
  return (
    state.kind === "connected" ||
    (state.kind === "api_key_mode" && state.configured)
  );
}
