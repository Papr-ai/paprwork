import { describe, expect, it, vi } from "vitest";
import {
  decideHandoffAccount,
  handoffLanding,
  HandoffRedeemError,
  isHandoffUrl,
  memoryBaseUrl,
  parseHandoffCode,
  redeemHandoffCode,
} from "./paprHandoff.js";

const CODE = "AbC_dEf-1234567890abcdefghijklmnopqrstuvwxy"; // token_urlsafe(32) shape

describe("handoff link parsing", () => {
  it("accepts memory's papr://auth/handoff links (extra params ignored)", () => {
    const url = `papr://auth/handoff?code=${CODE}&slug=linkedin-outreach&ns=n1&view=setup`;
    expect(isHandoffUrl(url)).toBe(true);
    expect(parseHandoffCode(url)).toBe(CODE);
  });
  it("rejects other hosts, paths, and junk codes", () => {
    expect(parseHandoffCode(`papr://auth/callback?code=${CODE}`)).toBeNull();
    expect(parseHandoffCode(`https://auth/handoff?code=${CODE}`)).toBeNull();
    expect(parseHandoffCode("papr://auth/handoff?code=short")).toBeNull();
    expect(parseHandoffCode("papr://auth/handoff?code=has%20space%20in%20it%20padding")).toBeNull();
    expect(parseHandoffCode("not a url")).toBeNull();
  });
  it("finds memory the same way the gateway does", () => {
    expect(memoryBaseUrl({})).toBe("https://memory.papr.ai");
    expect(memoryBaseUrl({ PAPR_AI_PROXY_BASE_URL: "https://staging.papr.ai/v1/ai" })).toBe("https://staging.papr.ai");
    expect(memoryBaseUrl({ PAPR_MEMORY_SERVER_URL: "http://localhost:8000/" })).toBe("http://localhost:8000");
  });
});

describe("redeemHandoffCode", () => {
  it("posts only the code and returns session, profile and intent", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({
        userId: "u1", email: "a@acme.com", displayName: "Ada", sessionToken: "r:mac", sessionExpiresAt: "2027-10-10T00:00:00Z",
        namespaceId: "n1", intent: { appNamespaceId: "n1", appSlug: "linkedin-outreach" },
      })),
    );
    const out = await redeemHandoffCode(CODE, { baseUrl: "https://m", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toMatchObject({ userId: "u1", email: "a@acme.com", sessionToken: "r:mac", intent: { appSlug: "linkedin-outreach" } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://m/v1/cloud/handoff/redeem");
    expect(JSON.parse(String(init.body))).toEqual({ code: CODE, device: "papr-desktop" });
  });
  it("explains used/expired links and network failures", async () => {
    const used = vi.fn(async () => new Response("{}", { status: 400 }));
    await expect(redeemHandoffCode(CODE, { baseUrl: "m", fetchImpl: used as unknown as typeof fetch })).rejects.toThrow(/expired or was already used/);
    const down = vi.fn(async () => { throw new Error("ENOTFOUND"); });
    await expect(redeemHandoffCode(CODE, { baseUrl: "m", fetchImpl: down as unknown as typeof fetch })).rejects.toBeInstanceOf(HandoffRedeemError);
  });
});

describe("landing and account decision", () => {
  it("drafts a message about the app, or nothing", () => {
    expect(handoffLanding({ appNamespaceId: "n1", appSlug: "linkedin-outreach", view: "send" }).message).toBe(
      "Let's keep working on linkedin-outreach (send) from Claude: https://apps.papr.ai/n1/linkedin-outreach",
    );
    expect(handoffLanding({}).message).toBe("");
  });
  it("never switches accounts silently", () => {
    expect(decideHandoffAccount(undefined, "u1")).toBe("sign_in");
    expect(decideHandoffAccount("u1", "u1")).toBe("same_user");
    expect(decideHandoffAccount("u2", "u1")).toBe("different_user");
  });
});
