/**
 * Tracking for refresh tokens the provider has already rejected.
 *
 * A refresh grant is deterministic: if the authorization server answers
 * `invalid_grant` ("Refresh token not found or invalid"), that same token will
 * be rejected every subsequent time. The refresh timer does not know that, so
 * it re-posts the dead grant on every tick — a doomed network call, a keychain
 * decrypt, an error log, and a status broadcast that flaps the UI, forever.
 *
 * Held in memory on purpose. This records a rejection we *observed*; after a
 * restart we hold no such evidence and should try again rather than carry a
 * verdict we can no longer justify.
 */

/** `invalid_grant` is the OAuth 2.0 code for a refresh token that will not work. */
const INVALID_GRANT = "invalid_grant";

/**
 * Whether the failure means the refresh token itself is dead, as opposed to a
 * transport or gateway problem.
 *
 * Deliberately narrow: a 403 Cloudflare challenge or a network timeout says
 * nothing about the token and must stay retryable, so only the explicit
 * `invalid_grant` code counts.
 */
export function isInvalidGrantError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string"
      ? error
      : "";
  return message.toLowerCase().includes(INVALID_GRANT);
}

/**
 * Remembers which refresh tokens have been rejected, keyed by the token value
 * itself so a newly issued one is never covered by an older verdict.
 */
export class RefreshRejectionLedger {
  private readonly rejected = new Map<string, Set<string>>();

  /** Record that `refreshToken` was rejected outright for `provider`. */
  record(provider: string, refreshToken: string): void {
    const key = refreshToken.trim();
    if (!key) return;
    const existing = this.rejected.get(provider);
    if (existing) existing.add(key);
    else this.rejected.set(provider, new Set([key]));
  }

  /** Whether posting `refreshToken` again is known to be pointless. */
  isRejected(provider: string, refreshToken: string | undefined): boolean {
    const key = refreshToken?.trim();
    if (!key) return false;
    return this.rejected.get(provider)?.has(key) === true;
  }

  /** Forget a provider's verdicts, e.g. after the user reconnects. */
  clear(provider: string): void {
    this.rejected.delete(provider);
  }
}
