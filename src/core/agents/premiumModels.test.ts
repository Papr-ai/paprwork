import { describe, expect, it, vi } from "vitest";
import { isPremiumProxyModel } from "./premiumModels";
import { DEFAULT_AUTO_LADDERS, ladderModelIds } from "./autoLadders";
import { clearPaprEntitlementsCache, getPaprEntitlements } from "../../gateway/utils/paprEntitlements";

describe("isPremiumProxyModel (mirrors credits.yaml premium_input_usd_per_1m: 1.50)", () => {
  it("flags models at or above $1.50/1M input", () => {
    for (const id of [
      "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2", "claude-sonnet-4-6",
      "gpt-5-6-sol", "gpt-5.6-sol", "gpt-5-6-terra", "gpt-5.5", "gpt-5.5-high", "gpt-5.3-codex", "gpt-6-astra",
      "gemini-3.1-pro-preview", "gemini-3.5-flash", "gemini-4-argon", "kimi-k3",
    ]) expect(isPremiumProxyModel(id), id).toBe(true);
  });

  it("keeps Haiku, GLM, Flash, Luna and mini open", () => {
    for (const id of [
      "claude-haiku-4-5", "glm-5.2", "glm-5.2-max", "gemini-3.8-flash", "gemini-3.5-flash-lite",
      "gemini-2.5-flash", "gpt-5-6-luna", "gpt-5.4-mini", "openai/gpt-oss-120b", "qwen/qwen3-32b", "auto",
    ]) expect(isPremiumProxyModel(id), id).toBe(false);
  });

  it("every Auto ladder still has an open model on OpenAI and Google", () => {
    for (const p of ["openai", "google"] as const) {
      const open = ladderModelIds(DEFAULT_AUTO_LADDERS[p]!).filter((m) => !isPremiumProxyModel(m));
      expect(open.length, p).toBeGreaterThan(0);
    }
  });
});

describe("getPaprEntitlements", () => {
  it("reads premium=false from the server", async () => {
    clearPaprEntitlementsCache();
    const f = vi.fn(async () => new Response(JSON.stringify({ premium: false, reason: "free_plan" }), { status: 200 }));
    const ent = await getPaprEntitlements("k1", f as unknown as typeof fetch);
    expect(ent).toEqual({ premium: false, reason: "free_plan" });
    await getPaprEntitlements("k1", f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(1); // cached
  });

  it("fails open when the endpoint is missing or down", async () => {
    clearPaprEntitlementsCache();
    const notFound = vi.fn(async () => new Response("nope", { status: 404 }));
    expect((await getPaprEntitlements("k2", notFound as unknown as typeof fetch)).premium).toBe(true);
    const down = vi.fn(async () => { throw new Error("offline"); });
    expect((await getPaprEntitlements("k3", down as unknown as typeof fetch)).premium).toBe(true);
  });
});
