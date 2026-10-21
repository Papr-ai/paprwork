import express from "express";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { memoryHandoff } from "../src/gateway/services/mcp/handoff.js";
import { openPageUrl, registerOpenPage } from "../src/gateway/services/mcp/openPage.js";

const caller = { userId: "u", sessionToken: "s" } as never;
const fakeFetch = (async () =>
  new Response(JSON.stringify({ url: "papr://auth/handoff?code=abc", expiresAt: "2026-01-01" }))) as unknown as typeof fetch;
const MCP = "https://papr-cloud-app-host-mcp.example.run.app/mcp";

describe("https hand-off page", () => {
  it("is served from the MCP host's own origin and keeps the code in the fragment", () => {
    const url = openPageUrl(MCP, "papr://auth/handoff?code=abc", "https://apps.papr.ai/ns/slug");
    expect(url.startsWith("https://papr-cloud-app-host-mcp.example.run.app/open#")).toBe(true);
    expect(url).not.toContain("?");
    const frag = new URLSearchParams(url.split("#")[1]);
    expect(frag.get("u")).toBe("papr://auth/handoff?code=abc");
    expect(frag.get("web")).toBe("https://apps.papr.ai/ns/slug");
  });

  it("MCP host: page on its own origin, web fallback on apps.papr.ai", async () => {
    const link = await memoryHandoff("https://memory.test", fakeFetch, "https://apps.papr.ai", MCP)(caller, {
      appNamespaceId: "ns",
      appSlug: "slug",
    });
    expect(link.url.startsWith("https://papr-cloud-app-host-mcp.example.run.app/open#")).toBe(true);
    expect(link.paprUrl).toBe("papr://auth/handoff?code=abc");
    expect(new URLSearchParams(link.url.split("#")[1]).get("web")).toBe("https://apps.papr.ai/ns/slug");
  });

  it("stays papr:// for the desktop gateway (no page base)", async () => {
    const link = await memoryHandoff("https://memory.test", fakeFetch, "https://apps.papr.ai")(caller, {});
    expect(link.url).toBe("papr://auth/handoff?code=abc");
  });

  it("page allows the apps origin as a cross-origin web fallback", async () => {
    const app = express();
    registerOpenPage(app, "https://apps.papr.ai");
    const srv = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/open`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toContain('var WO="https://apps.papr.ai/"');
    } finally {
      srv.close();
    }
  });
});
