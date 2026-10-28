import { describe, expect, it, vi } from "vitest";
import {
  decideHandoffAccount,
  handoffLanding,
  HandoffRedeemError,
  isHandoffUrl,
  memoryBaseUrl,
  parseHandoffCode,
  pickHandoffWindow,
  redeemHandoffCode,
  resolveHandoffApp,
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
  it("dev profile accepts papr-dev:// hand-off links, not papr://", async () => {
    const prev = process.env.PAPR_PROFILE;
    process.env.PAPR_PROFILE = "dev";
    vi.resetModules();
    try {
      const dev = await import("./paprHandoff.js");
      expect(dev.isHandoffUrl(`papr-dev://auth/handoff?code=${CODE}`)).toBe(true);
      expect(dev.parseHandoffCode(`papr-dev://auth/handoff?code=${CODE}`)).toBe(CODE);
      expect(dev.parseHandoffCode(`papr://auth/handoff?code=${CODE}`)).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.PAPR_PROFILE;
      else process.env.PAPR_PROFILE = prev;
      vi.resetModules();
    }
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

describe("landing on the app itself", () => {
  const intent = { appNamespaceId: "85ZIB7mD1V", appSlug: "linkedin-outreach-shawkat", view: "outreach" };
  const apps = (list: unknown[]) =>
    vi.fn(async () => new Response(JSON.stringify({ apps: list }), { status: 200 })) as unknown as typeof fetch;

  it("finds the local appId behind namespace + slug, as the Claude user", async () => {
    const fetchImpl = apps([
      { appId: "6b0a8fa3", namespaceId: "85ZIB7mD1V", slug: "linkedin-outreach", name: "LinkedIn Outreach" },
      { appId: "08369ded-3d7f", namespaceId: "85ZIB7mD1V", slug: "linkedin-outreach-shawkat", name: "LinkedIn Outreach" },
    ]);
    expect(await resolveHandoffApp(intent, "tok", { baseUrl: "https://m", fetchImpl })).toEqual({
      appId: "08369ded-3d7f",
      name: "LinkedIn Outreach",
    });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://m/v1/cloud/apps/accessible");
    expect((init as RequestInit).headers).toMatchObject({ "X-Session-Token": "tok" });
  });

  it("is null when the app isn't listed, the id looks wrong, or memory fails", async () => {
    expect(await resolveHandoffApp(intent, "tok", { fetchImpl: apps([]) })).toBeNull();
    expect(await resolveHandoffApp(intent, "tok", { fetchImpl: apps([{ ...intent, appId: "../x", namespaceId: "85ZIB7mD1V", slug: intent.appSlug }]) })).toBeNull();
    const down = vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    expect(await resolveHandoffApp(intent, "tok", { fetchImpl: down })).toBeNull();
    expect(await resolveHandoffApp({}, "tok", { fetchImpl: down })).toBeNull();
  });

  it("opens the app beside a drafted chat when it's here, else the old web-link draft", () => {
    const here = handoffLanding(intent, undefined, { appId: "08369ded", name: "LinkedIn Outreach" });
    expect(here).toMatchObject({ appId: "08369ded", title: "Continued from Claude" });
    expect(here.message).toBe("Let's keep working on LinkedIn Outreach from Claude.");
    const picked = handoffLanding({ ...intent, view: "outreach:c_1a13e12fb3deb2073" }, undefined, { appId: "08369ded", name: "LinkedIn Outreach" });
    expect(picked.message).toContain("set to run from this Mac");
    expect(picked.message).not.toMatch(/set(ting)? it up/);
    expect(handoffLanding(intent, undefined, null).appId).toBeUndefined();
  });
});

describe("handoffLanding from the web card", () => {
  it("explains the desktop run instead of crediting Claude", () => {
    const landing = handoffLanding({ appNamespaceId: "n1", appSlug: "linkedin-outreach", source: "web" });
    expect(landing.title).toBe("From the web");
    expect(landing.message).toContain("needs Papr Work desktop");
  });
});

describe("pickHandoffWindow", () => {
  const w = (name: string, visible: boolean, destroyed = false) => ({ name, isVisible: () => visible, isDestroyed: () => destroyed });
  it("lands in the main window, never a hidden preview window opened earlier", () => {
    const preview = w("preview", false);
    const main = w("main", true);
    expect(pickHandoffWindow(main, [preview, main])?.name).toBe("main");
  });
  it("without a main window, only a visible window qualifies", () => {
    expect(pickHandoffWindow(null, [w("preview", false), w("other", true)])?.name).toBe("other");
    expect(pickHandoffWindow(null, [w("preview", false)])).toBeNull();
    expect(pickHandoffWindow(w("main", true, true), [w("preview", false)])).toBeNull();
  });
});
