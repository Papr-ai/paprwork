import { describe, expect, it } from "vitest";
import { memoryHandoff } from "../src/gateway/services/mcp/handoff.js";
import { openPageUrl } from "../src/gateway/services/mcp/openPage.js";

const caller = { userId: "u", sessionToken: "s" } as never;
const fakeFetch = (async () =>
  new Response(JSON.stringify({ url: "papr://auth/handoff?code=abc", expiresAt: "2026-01-01" }))) as unknown as typeof fetch;

describe("https hand-off page", () => {
  it("keeps the one-time code in the fragment, never the query", () => {
    const url = openPageUrl("https://apps.papr.ai/", "papr://auth/handoff?code=abc", "https://apps.papr.ai/ns/slug");
    expect(url.startsWith("https://apps.papr.ai/open#")).toBe(true);
    expect(url).not.toContain("?");
    const frag = new URLSearchParams(url.split("#")[1]);
    expect(frag.get("u")).toBe("papr://auth/handoff?code=abc");
    expect(frag.get("web")).toBe("https://apps.papr.ai/ns/slug");
  });

  it("returns an https link Claude can open when an apps base URL is set", async () => {
    const link = await memoryHandoff("https://memory.test", fakeFetch, "https://apps.papr.ai")(caller, {
      appNamespaceId: "ns",
      appSlug: "slug",
    });
    expect(link.url.startsWith("https://apps.papr.ai/open#")).toBe(true);
    expect(link.paprUrl).toBe("papr://auth/handoff?code=abc");
    expect(new URLSearchParams(link.url.split("#")[1]).get("web")).toBe("https://apps.papr.ai/ns/slug");
  });

  it("stays papr:// for the desktop gateway (no apps base URL)", async () => {
    const link = await memoryHandoff("https://memory.test", fakeFetch)(caller, {});
    expect(link.url).toBe("papr://auth/handoff?code=abc");
  });
});
