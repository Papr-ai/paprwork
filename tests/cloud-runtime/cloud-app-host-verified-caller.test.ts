import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  clearVerifiedCallerCache,
  resolveVerifiedCaller,
} from "../../src/gateway/services/appRuntime/verifiedCallerIdentity.js";
import { buildSessionCookie } from "../../src/gateway/services/appRuntime/cloudAppHostCookies.js";

const ok = (objectId: string, email?: string) => async () => ({ objectId, ...(email ? { email } : {}) });
const bad = async () => null;
const cookieFor = (token: string, user: string) =>
  buildSessionCookie(token, true, user, "a@b.c").split(";")[0];

describe("verified caller identity", () => {
  const prev = process.env.PAPR_CLOUD_APP_HOST_KEY;
  beforeEach(() => {
    process.env.PAPR_CLOUD_APP_HOST_KEY = "test-host-key";
    clearVerifiedCallerCache();
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.PAPR_CLOUD_APP_HOST_KEY;
    else process.env.PAPR_CLOUD_APP_HOST_KEY = prev;
  });

  it("ignores x-papr-external-user-id with no session (spoof attempt)", async () => {
    const c = await resolveVerifiedCaller({ headers: { "x-papr-external-user-id": "victim" } }, ok("x"));
    expect(c.userId).toBeUndefined();
    expect(c.rejectedClaim).toBe(true);
  });

  it("ignores a header id that differs from the validated session token", async () => {
    const c = await resolveVerifiedCaller(
      { headers: { "x-session-token": "tok", "x-papr-external-user-id": "victim" } },
      ok("attacker"),
    );
    expect(c.userId).toBe("attacker");
    expect(c.rejectedClaim).toBe(true);
  });

  it("ignores a header id that differs from the signed cookie", async () => {
    const c = await resolveVerifiedCaller(
      { headers: { cookie: cookieFor("tok", "alice"), "x-papr-external-user-id": "victim" } },
      ok("nope"),
    );
    expect(c.userId).toBe("alice");
    expect(c.rejectedClaim).toBe(true);
  });

  it("accepts a header id that matches the validated session", async () => {
    const c = await resolveVerifiedCaller(
      { headers: { "x-session-token": "tok", "x-papr-external-user-id": "alice" } },
      ok("alice", "a@x.io"),
    );
    expect(c).toEqual({ userId: "alice", sessionToken: "tok", email: "a@x.io" });
  });

  it("uses the signed cookie without calling Parse", async () => {
    const validate = vi.fn(ok("nope"));
    const c = await resolveVerifiedCaller({ headers: { cookie: cookieFor("tok", "alice") } }, validate);
    expect(c.userId).toBe("alice");
    expect(validate).not.toHaveBeenCalled();
  });

  it("rejects a forged / unsigned session cookie", async () => {
    const c = await resolveVerifiedCaller(
      { headers: { cookie: "papr_session=" + encodeURIComponent('{"sessionToken":"t","externalUserId":"victim","exp":9e15}') } },
      ok("x"),
    );
    expect(c.userId).toBeUndefined();
  });

  it("drops an invalid session token entirely", async () => {
    const c = await resolveVerifiedCaller({ headers: { "x-session-token": "bad" } }, bad);
    expect(c).toEqual({});
  });

  it("caches Parse validation per token", async () => {
    const validate = vi.fn(ok("alice"));
    await resolveVerifiedCaller({ headers: { "x-session-token": "tok" } }, validate, 1_000);
    await resolveVerifiedCaller({ headers: { "x-session-token": "tok" } }, validate, 2_000);
    expect(validate).toHaveBeenCalledTimes(1);
    await resolveVerifiedCaller({ headers: { "x-session-token": "tok" } }, validate, 1_000 + 6 * 60_000);
    expect(validate).toHaveBeenCalledTimes(2);
  });
});

describe("API-key caller acting user claim", () => {
  beforeEach(() => {
    process.env.PAPR_CLOUD_APP_HOST_KEY = "test-host-key";
    clearVerifiedCallerCache();
  });

  it("keeps the claim as untrusted apiKeyClaim (never userId)", async () => {
    const c = await resolveVerifiedCaller(
      { headers: { "x-api-key": "k", "x-papr-external-user-id": "member1" } },
      ok("x"),
    );
    expect(c.userId).toBeUndefined();
    expect(c.apiKeyClaim).toBe("member1");
  });

  it("no API key → claim is still rejected", async () => {
    const c = await resolveVerifiedCaller({ headers: { "x-papr-external-user-id": "member1" } }, ok("x"));
    expect(c.apiKeyClaim).toBeUndefined();
    expect(c.rejectedClaim).toBe(true);
  });

  it("session wins over an API-key claim", async () => {
    const c = await resolveVerifiedCaller(
      { headers: { "x-api-key": "k", "x-session-token": "tok", "x-papr-external-user-id": "victim" } },
      ok("alice"),
    );
    expect(c.userId).toBe("alice");
    expect(c.apiKeyClaim).toBeUndefined();
    expect(c.rejectedClaim).toBe(true);
  });
});
