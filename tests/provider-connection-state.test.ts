import { describe, expect, it } from "vitest";
import {
  deriveProviderConnectionState,
  isHealthyConnection,
  type ProviderConnectionInputs,
} from "../ui/utils/providerConnectionState";
import {
  claudeAccessTokenIsLive,
  parseClaudeCliCredentials,
} from "../src/core/services/claudeCliCredentials";

const base: ProviderConnectionInputs = {
  mode: "oauth",
  platformApiKeyConfigured: false,
  status: { connected: true },
  authRejected: false,
};

describe("deriveProviderConnectionState", () => {
  it("reports a live token as connected", () => {
    expect(deriveProviderConnectionState(base)).toEqual({ kind: "connected" });
  });

  it("reports no token as disconnected", () => {
    expect(
      deriveProviderConnectionState({
        ...base,
        status: { connected: false },
      }),
    ).toEqual({ kind: "disconnected" });
  });

  // The reported bug: card read "Connected" in green while every request was
  // being refused, with the only contrary signal a small "Token: Expired".
  it("does not report an expired unrenewable token as connected", () => {
    const state = deriveProviderConnectionState({
      ...base,
      status: { connected: true, isExpired: true, canRenew: false },
    });

    expect(state).toEqual({
      kind: "needs_signin",
      reason: "expired",
      fallsBackToApiKey: false,
    });
    expect(isHealthyConnection(state)).toBe(false);
  });

  it("leaves an expired but renewable token alone, since it self-heals", () => {
    const state = deriveProviderConnectionState({
      ...base,
      status: { connected: true, isExpired: true, canRenew: true },
    });

    expect(state).toEqual({ kind: "connected" });
    expect(isHealthyConnection(state)).toBe(true);
  });

  it("flags the silent fallback when a platform key will serve requests", () => {
    expect(
      deriveProviderConnectionState({
        ...base,
        platformApiKeyConfigured: true,
        status: { connected: true, isExpired: true, canRenew: false },
      }),
    ).toEqual({
      kind: "needs_signin",
      reason: "expired",
      fallsBackToApiKey: true,
    });
  });

  it("treats an observed rejection as needing sign-in even when unexpired", () => {
    expect(
      deriveProviderConnectionState({
        ...base,
        status: { connected: true, isExpired: false, canRenew: true },
        authRejected: true,
      }),
    ).toEqual({
      kind: "needs_signin",
      reason: "rejected",
      fallsBackToApiKey: false,
    });
  });

  it("prefers the observed rejection over the derived expiry", () => {
    const state = deriveProviderConnectionState({
      ...base,
      status: { connected: true, isExpired: true, canRenew: false },
      authRejected: true,
    });

    expect(state).toMatchObject({ reason: "rejected" });
  });

  it("ignores OAuth state entirely in API key mode", () => {
    // Otherwise switching to API key looks like it did not apply, because the
    // OAuth badge keeps reporting the token it is no longer using.
    expect(
      deriveProviderConnectionState({
        mode: "apiKey",
        platformApiKeyConfigured: true,
        status: { connected: true, isExpired: true, canRenew: false },
        authRejected: true,
      }),
    ).toEqual({ kind: "api_key_mode", configured: true });
  });

  it("does not call API key mode healthy without a key", () => {
    expect(
      isHealthyConnection({ kind: "api_key_mode", configured: false }),
    ).toBe(false);
  });

  it("treats an unknown expiry as connected rather than alarming", () => {
    // A pasted setup token carries no expiry; guessing "broken" would send
    // users to reconnect a credential that works.
    expect(
      deriveProviderConnectionState({
        ...base,
        status: { connected: true },
      }),
    ).toEqual({ kind: "connected" });
  });
});

describe("claudeAccessTokenIsLive", () => {
  const now = Date.UTC(2026, 8, 7);
  const hour = 3_600_000;

  it("accepts a live access token", () => {
    expect(
      claudeAccessTokenIsLive(
        { accessToken: "sk-ant-oat-live", expiresAt: now + hour },
        { now },
      ),
    ).toBe(true);
  });

  // The reported bug: Connect found this, adopted it, reported success, and
  // put the user back on the expired card they pressed Connect to escape.
  it("rejects an expired token with no refresh token", () => {
    expect(
      claudeAccessTokenIsLive(
        { accessToken: "sk-ant-oat-dead", expiresAt: now - hour },
        { now },
      ),
    ).toBe(false);
  });

  it("rejects an expired token whose refresh token echoes the access token", () => {
    expect(
      claudeAccessTokenIsLive(
        {
          accessToken: "sk-ant-oat-dead",
          refreshToken: "sk-ant-oat-dead",
          expiresAt: now - hour,
        },
        { now },
      ),
    ).toBe(false);
  });

  it("rejects an expired token even when it carries a real refresh token", () => {
    // This case previously returned true, on the theory that a refresh token
    // makes an expired credential recoverable. That is an assumption, and
    // acting on it is what let a five-month-dead credential be adopted as if
    // it worked. Callers that can accept a renewable credential now run the
    // refresh and check the result instead of predicting it.
    expect(
      claudeAccessTokenIsLive(
        {
          accessToken: "sk-ant-oat-dead",
          refreshToken: "sk-ant-ort-real",
          expiresAt: now - hour,
        },
        { now },
      ),
    ).toBe(false);
  });

  it("accepts credentials with no stated expiry", () => {
    expect(
      claudeAccessTokenIsLive({ accessToken: "sk-ant-oat-pasted" }, { now }),
    ).toBe(true);
  });

  it("rejects a real Claude Code blob once expired", () => {
    const parsed = parseClaudeCliCredentials(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "sk-ant-oat01-abc",
          refreshToken: "sk-ant-oat01-abc",
          expiresAt: now - hour,
        },
      }),
    );

    expect(parsed).not.toBeNull();
    expect(claudeAccessTokenIsLive(parsed!, { now })).toBe(false);
  });
});
