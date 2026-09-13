import { describe, it, expect } from "vitest";
import {
  claudeCredentialsToTokenLifetime,
  isUsableRefreshToken,
  parseClaudeCliCredentials,
} from "../src/core/services/claudeCliCredentials";

const HOUR_SECONDS = 60 * 60;
const YEAR_SECONDS = 365 * 24 * HOUR_SECONDS;
const NOW = 1_700_000_000_000;

/** The shape Claude Code writes to the keychain / ~/.claude/.credentials.json. */
function claudeCodeRecord(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-oat01-access",
      refreshToken: "sk-ant-ort01-refresh",
      expiresAt: NOW + 8 * HOUR_SECONDS * 1000,
      scopes: ["user:inference"],
      ...overrides,
    },
  });
}

describe("parseClaudeCliCredentials", () => {
  it("keeps the refresh token and expiry, not just the access token", () => {
    const parsed = parseClaudeCliCredentials(claudeCodeRecord());

    expect(parsed).toEqual({
      accessToken: "sk-ant-oat01-access",
      refreshToken: "sk-ant-ort01-refresh",
      expiresAt: NOW + 8 * HOUR_SECONDS * 1000,
    });
  });

  it("reads a bare oauth record without the claudeAiOauth wrapper", () => {
    const parsed = parseClaudeCliCredentials(
      JSON.stringify({
        accessToken: "sk-ant-oat01-access",
        refreshToken: "sk-ant-ort01-refresh",
        expiresAt: NOW,
      }),
    );

    expect(parsed?.refreshToken).toBe("sk-ant-ort01-refresh");
  });

  it("reports a token with no companion fields rather than inventing them", () => {
    const parsed = parseClaudeCliCredentials(
      JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-access" } }),
    );

    expect(parsed).toEqual({ accessToken: "sk-ant-oat01-access" });
    expect(parsed?.expiresAt).toBeUndefined();
  });

  it("returns null for unusable input instead of throwing", () => {
    expect(parseClaudeCliCredentials("not json")).toBeNull();
    expect(parseClaudeCliCredentials("")).toBeNull();
    expect(parseClaudeCliCredentials(JSON.stringify({ other: 1 }))).toBeNull();
    expect(
      parseClaudeCliCredentials(JSON.stringify({ claudeAiOauth: {} })),
    ).toBeNull();
  });
});

describe("isUsableRefreshToken", () => {
  it("accepts a genuine refresh token", () => {
    expect(
      isUsableRefreshToken("sk-ant-ort01-refresh", "sk-ant-oat01-access"),
    ).toBe(true);
  });

  it("rejects the access token echoed into the refresh slot", () => {
    // The exact record older builds stored, and the reason its refresh
    // attempts could only ever fail.
    expect(
      isUsableRefreshToken("sk-ant-oat01-access", "sk-ant-oat01-access"),
    ).toBe(false);
  });

  it("rejects any access token in the refresh slot, even a different one", () => {
    expect(
      isUsableRefreshToken("sk-ant-oat01-other", "sk-ant-oat01-access"),
    ).toBe(false);
  });

  it("rejects a missing or blank refresh token", () => {
    expect(isUsableRefreshToken(undefined, "sk-ant-oat01-access")).toBe(false);
    expect(isUsableRefreshToken("   ", "sk-ant-oat01-access")).toBe(false);
  });
});

describe("claudeCredentialsToTokenLifetime", () => {
  it("converts a real expiry to seconds from now, not a year", () => {
    const lifetime = claudeCredentialsToTokenLifetime(
      {
        accessToken: "sk-ant-oat01-access",
        refreshToken: "sk-ant-ort01-refresh",
        expiresAt: NOW + 8 * HOUR_SECONDS * 1000,
      },
      { fallbackTtlSeconds: YEAR_SECONDS, now: NOW },
    );

    expect(lifetime).toEqual({
      accessToken: "sk-ant-oat01-access",
      refreshToken: "sk-ant-ort01-refresh",
      expiresIn: 8 * HOUR_SECONDS,
    });
  });

  it("reports an already-elapsed expiry as negative so it reads as expired", () => {
    const lifetime = claudeCredentialsToTokenLifetime(
      {
        accessToken: "sk-ant-oat01-access",
        refreshToken: "sk-ant-ort01-refresh",
        expiresAt: NOW - HOUR_SECONDS * 1000,
      },
      { fallbackTtlSeconds: YEAR_SECONDS, now: NOW },
    );

    expect(lifetime.expiresIn).toBe(-HOUR_SECONDS);
  });

  it("falls back to the assumed lifetime only when no expiry was supplied", () => {
    const lifetime = claudeCredentialsToTokenLifetime(
      { accessToken: "sk-ant-oat01-access" },
      { fallbackTtlSeconds: YEAR_SECONDS, now: NOW },
    );

    expect(lifetime.expiresIn).toBe(YEAR_SECONDS);
    // storeToken requires a refresh token, so the access token stands in — and
    // isUsableRefreshToken is what stops it being redeemed.
    expect(lifetime.refreshToken).toBe("sk-ant-oat01-access");
    expect(
      isUsableRefreshToken(lifetime.refreshToken, lifetime.accessToken),
    ).toBe(false);
  });

  it("does not carry a fabricated refresh token through as usable", () => {
    const lifetime = claudeCredentialsToTokenLifetime(
      {
        accessToken: "sk-ant-oat01-access",
        refreshToken: "sk-ant-oat01-access",
        expiresAt: NOW + 8 * HOUR_SECONDS * 1000,
      },
      { fallbackTtlSeconds: YEAR_SECONDS, now: NOW },
    );

    expect(
      isUsableRefreshToken(lifetime.refreshToken, lifetime.accessToken),
    ).toBe(false);
  });

  it("round-trips a Claude Code record end to end", () => {
    const parsed = parseClaudeCliCredentials(claudeCodeRecord());
    const lifetime = claudeCredentialsToTokenLifetime(parsed!, {
      fallbackTtlSeconds: YEAR_SECONDS,
      now: NOW,
    });

    expect(lifetime.expiresIn).toBe(8 * HOUR_SECONDS);
    expect(
      isUsableRefreshToken(lifetime.refreshToken, lifetime.accessToken),
    ).toBe(true);
  });
});
