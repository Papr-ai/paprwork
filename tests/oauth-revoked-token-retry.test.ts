import { describe, expect, it } from "vitest";
import {
  adoptRefreshedToken,
  isOAuthTokenRejection,
} from "../src/gateway/services/providers/oauthRevokedRetry";

describe("isOAuthTokenRejection", () => {
  it("matches the revoked-token body Anthropic returns", () => {
    expect(
      isOAuthTokenRejection(
        '401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."}}',
      ),
    ).toBe(true);
    expect(isOAuthTokenRejection({ statusCode: 401 })).toBe(true);
  });
  it("ignores rate limits and spent allowance", () => {
    expect(isOAuthTokenRejection({ statusCode: 429 })).toBe(false);
    expect(isOAuthTokenRejection("401 usage limit reached")).toBe(false);
  });
});

describe("adoptRefreshedToken", () => {
  it("installs a newer token on the live options", async () => {
    const opts = { apiKey: "old" };
    expect(await adoptRefreshedToken(opts, async () => "new")).toBe(true);
    expect(opts.apiKey).toBe("new");
  });
  it("does not loop when the store holds the same token or nothing", async () => {
    const opts = { apiKey: "same" };
    expect(await adoptRefreshedToken(opts, async () => "same")).toBe(false);
    expect(await adoptRefreshedToken(opts, async () => null)).toBe(false);
    expect(await adoptRefreshedToken(opts, undefined)).toBe(false);
    expect(await adoptRefreshedToken(opts, async () => { throw new Error("x"); })).toBe(false);
  });
});
