import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_EXPIRY_SKEW_MS,
  claudeAccessTokenIsLive,
  claudeCredentialsAreUsable,
  type ClaudeCliCredentials,
} from "../src/core/services/claudeCliCredentials.js";
import {
  isInvalidGrantError,
  RefreshRejectionLedger,
} from "../src/core/services/oauthRefreshRejection.js";

/**
 * The exact credential from the reported failure: Claude Code's Keychain entry
 * carried a real refresh token and an access token that had expired 136 days
 * earlier, and adopting it overwrote a token the user had just entered by hand.
 */
const APRIL_KEYCHAIN_CREDENTIAL: ClaudeCliCredentials = {
  accessToken: "sk-ant-oat-april",
  refreshToken: "sk-ant-ort-april",
  expiresAt: Date.parse("2026-04-24T23:03:09.865Z"),
};

const SEPTEMBER_NOW = Date.parse("2026-09-07T23:20:00.000Z");

describe("claudeAccessTokenIsLive", () => {
  it("rejects the expired Keychain credential that caused the overwrite", () => {
    expect(
      claudeAccessTokenIsLive(APRIL_KEYCHAIN_CREDENTIAL, {
        now: SEPTEMBER_NOW,
      }),
    ).toBe(false);
  });

  it("is stricter than claudeCredentialsAreUsable, which the bug needed", () => {
    // Pins the distinction the fix turns on. `claudeCredentialsAreUsable`
    // answers "could these ever authenticate?", so a refresh token makes even
    // the April credential "usable" — which is why simply reusing that
    // predicate at the adoption site would not have fixed anything.
    expect(
      claudeCredentialsAreUsable(APRIL_KEYCHAIN_CREDENTIAL, SEPTEMBER_NOW),
    ).toBe(true);
    expect(
      claudeAccessTokenIsLive(APRIL_KEYCHAIN_CREDENTIAL, {
        now: SEPTEMBER_NOW,
      }),
    ).toBe(false);
  });

  it("accepts a credential whose access token is still live", () => {
    expect(
      claudeAccessTokenIsLive(
        { ...APRIL_KEYCHAIN_CREDENTIAL, expiresAt: SEPTEMBER_NOW + 3_600_000 },
        { now: SEPTEMBER_NOW },
      ),
    ).toBe(true);
  });

  it("rejects a credential lapsing inside the skew window", () => {
    expect(
      claudeAccessTokenIsLive(
        {
          ...APRIL_KEYCHAIN_CREDENTIAL,
          expiresAt: SEPTEMBER_NOW + CREDENTIAL_EXPIRY_SKEW_MS - 1,
        },
        { now: SEPTEMBER_NOW },
      ),
    ).toBe(false);
  });

  it("treats an absent expiry as live, keeping pasted setup-tokens working", () => {
    // The source never told us an expiry; callers apply a fallback TTL to
    // these, so discarding them would regress the manual paste flow.
    expect(
      claudeAccessTokenIsLive(
        { accessToken: "sk-ant-oat-pasted" },
        { now: SEPTEMBER_NOW },
      ),
    ).toBe(true);
  });
});

describe("isInvalidGrantError", () => {
  it("recognises the provider's rejection from the reported failure", () => {
    expect(
      isInvalidGrantError(
        new Error(
          'Token refresh failed: 400 - {"error": "invalid_grant", ' +
            '"error_description": "Refresh token not found or invalid"}',
        ),
      ),
    ).toBe(true);
  });

  it("leaves a Cloudflare challenge retryable", () => {
    // A 403 interstitial says nothing about the token. Condemning it here
    // would strand a perfectly good grant behind a transient gateway block.
    expect(
      isInvalidGrantError(
        new Error("Token refresh failed: 403 - <!DOCTYPE html>Just a moment..."),
      ),
    ).toBe(false);
  });

  it("leaves transport faults retryable", () => {
    expect(isInvalidGrantError(new Error("fetch failed: ETIMEDOUT"))).toBe(
      false,
    );
    expect(isInvalidGrantError(undefined)).toBe(false);
  });
});

describe("RefreshRejectionLedger", () => {
  it("suppresses a re-post of the token the provider rejected", () => {
    const ledger = new RefreshRejectionLedger();
    ledger.record("anthropic", "sk-ant-ort-dead");
    expect(ledger.isRejected("anthropic", "sk-ant-ort-dead")).toBe(true);
  });

  it("does not carry a verdict onto a newly issued refresh token", () => {
    // Keyed by token value, so reconnecting is enough to resume refreshing
    // without any explicit reset.
    const ledger = new RefreshRejectionLedger();
    ledger.record("anthropic", "sk-ant-ort-dead");
    expect(ledger.isRejected("anthropic", "sk-ant-ort-fresh")).toBe(false);
  });

  it("keeps verdicts per provider", () => {
    const ledger = new RefreshRejectionLedger();
    ledger.record("anthropic", "shared-value");
    expect(ledger.isRejected("openai", "shared-value")).toBe(false);
  });

  it("ignores blank tokens rather than banning the empty string", () => {
    const ledger = new RefreshRejectionLedger();
    ledger.record("anthropic", "   ");
    expect(ledger.isRejected("anthropic", "")).toBe(false);
    expect(ledger.isRejected("anthropic", undefined)).toBe(false);
  });

  it("forgets verdicts on disconnect", () => {
    const ledger = new RefreshRejectionLedger();
    ledger.record("anthropic", "sk-ant-ort-dead");
    ledger.clear("anthropic");
    expect(ledger.isRejected("anthropic", "sk-ant-ort-dead")).toBe(false);
  });
});
