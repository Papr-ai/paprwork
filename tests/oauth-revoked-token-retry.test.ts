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

import { streamWithTokenRetry } from "../src/gateway/services/providers/oauthRevokedRetry";

const revoked = {
  type: "error",
  error: '401 {"error":{"type":"authentication_error","message":"OAuth access token has been revoked."}}',
};

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("streamWithTokenRetry", () => {
  it("re-opens once with the current token after a revoked first answer", async () => {
    const seen: string[] = [];
    const open = async function* (o: Record<string, unknown>) {
      seen.push(String(o.apiKey));
      if (o.apiKey === "old") yield revoked;
      else yield { type: "text_delta" };
    };
    const events = await collect(streamWithTokenRetry(open, { apiKey: "old" }, async () => "new"));
    expect(seen).toEqual(["old", "new"]);
    expect(events).toEqual([{ type: "text_delta" }]);
  });
  it("surfaces the rejection when no newer token exists", async () => {
    const open = async function* () { yield revoked; };
    const events = await collect(streamWithTokenRetry(open, { apiKey: "old" }, async () => "old"));
    expect(events).toEqual([revoked]);
  });
  it("retries a thrown rejection and rethrows if unrecoverable", async () => {
    const open = async function* (): AsyncGenerator<{ type: string }> {
      throw new Error("401 OAuth access token has been revoked");
    };
    await expect(collect(streamWithTokenRetry(open, { apiKey: "a" }))).rejects.toThrow(/revoked/);
  });
  it("does not retry once output has started, or on unrelated errors", async () => {
    let calls = 0;
    const open = async function* () {
      calls++;
      yield { type: "text_delta" };
      yield revoked;
    };
    const events = await collect(streamWithTokenRetry(open, { apiKey: "a" }, async () => "b"));
    expect(calls).toBe(1);
    expect(events).toHaveLength(2);
    const rate = async function* () { yield { type: "error", error: "429 rate limit" }; };
    expect(await collect(streamWithTokenRetry(rate, { apiKey: "a" }, async () => "b"))).toHaveLength(1);
  });
});
