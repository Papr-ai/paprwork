import { describe, expect, it, vi } from "vitest";
import { decideMemberRequest, requestMember, setMemberCap, setMemberPolicy } from "./paprCreditSeats.js";

function fakeFetch() {
  const calls: Array<{ url: string; body: unknown }> = [];
  const f = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ status: "pending" }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("member requests client", () => {
  it("requests a seat / limit / access", async () => {
    const { f, calls } = fakeFetch();
    await requestMember("https://m", "t", "seat", f);
    expect(calls[0]).toEqual({ url: "https://m/v1/credits/members/request", body: { kind: "seat" } });
    await expect(requestMember("https://m", "t", "bogus" as never, f)).rejects.toThrow();
  });

  it("decides with cap and plan only when given", async () => {
    const { f, calls } = fakeFetch();
    await decideMemberRequest("https://m", "t", { userId: "abc123", kind: "limit", approve: true, capCredits: 50000 }, f);
    expect(calls[0]).toEqual({ url: "https://m/v1/credits/members/abc123/requests/limit/decide", body: { approve: true, capCredits: 50000 } });
    await decideMemberRequest("https://m", "t", { userId: "abc123", kind: "seat", approve: false }, f);
    expect(calls[1].body).toEqual({ approve: false });
    await expect(decideMemberRequest("https://m", "t", { userId: "../x", kind: "seat", approve: true }, f)).rejects.toThrow();
  });

  it("validates policy and cap", async () => {
    const { f, calls } = fakeFetch();
    await setMemberPolicy("https://m", "t", "approve", f);
    await setMemberCap("https://m", "t", 25000, f);
    expect(calls.map((c) => c.url)).toEqual(["https://m/v1/credits/member-usage", "https://m/v1/credits/member-cap"]);
    await expect(setMemberCap("https://m", "t", -1, f)).rejects.toThrow();
    await expect(setMemberPolicy("https://m", "t", "off" as never, f)).rejects.toThrow();
  });
});
