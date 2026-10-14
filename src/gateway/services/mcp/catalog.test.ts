/** Catalog time budget: Claude's connect check must never wait on a slow app list. */
import { beforeEach, describe, expect, it } from "vitest";
import { clearCatalogCache, loadClaudeCatalog, loadClaudeCatalogWithin } from "./catalog.js";
import { catalogBudgetMs } from "./server.js";

const caller = { userId: "u1", sessionToken: "s" } as never;
const app = (slug: string) => ({ appId: slug, namespaceId: "ns1", slug });
const cards = { version: 1, views: { home: { kind: "status", file: "home.html" } } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("catalog time budget", () => {
  beforeEach(() => clearCatalogCache());

  it("answers within budget while the build continues, then serves the finished catalog", async () => {
    const deps = { listAccessibleApps: async () => [app("a")], loadCardsManifest: async () => (await sleep(80), cards) };
    const first = await loadClaudeCatalogWithin(caller, deps, 10);
    expect(first).toEqual({ apps: [], complete: false });
    await sleep(120);
    const second = await loadClaudeCatalogWithin(caller, deps, 10);
    expect(second.complete).toBe(true);
    expect(second.apps.map((a) => a.slug)).toEqual(["a"]);
  });

  it("runs one build per user even when Claude retries", async () => {
    let lists = 0;
    const deps = { listAccessibleApps: async () => (lists++, await sleep(30), [app("a")]), loadCardsManifest: async () => cards };
    await Promise.all([loadClaudeCatalog(caller, deps), loadClaudeCatalog(caller, deps), loadClaudeCatalogWithin(caller, deps, 5)]);
    expect(lists).toBe(1);
  });

  it("skips an app whose cards.json is too slow", async () => {
    const deps = {
      listAccessibleApps: async () => [app("fast"), app("slow")],
      loadCardsManifest: async (_c: unknown, ref: { slug: string }) => (ref.slug === "slow" ? await sleep(200) : null, cards),
    };
    const apps = await loadClaudeCatalog(caller, deps, { manifestTimeoutMs: 40 });
    expect(apps.map((a) => a.slug)).toEqual(["fast"]);
  });

  it("still surfaces real errors from the app list", async () => {
    const deps = { listAccessibleApps: async () => { throw new Error("memory down"); }, loadCardsManifest: async () => null };
    await expect(loadClaudeCatalogWithin(caller, deps, 50)).rejects.toThrow("memory down");
  });

  it("gives initialize a short budget and tools/list a longer one", () => {
    expect(catalogBudgetMs({ method: "initialize" })).toBe(2_500);
    expect(catalogBudgetMs([{ method: "tools/list" }])).toBe(7_000);
  });
});

describe("catalog freshness", () => {
  beforeEach(() => clearCatalogCache());

  it("serves a stale catalog instantly and refreshes it in the background", async () => {
    let t = 0;
    let lists = 0;
    const deps = { listAccessibleApps: async () => (lists++, [app(`a${lists}`)]), loadCardsManifest: async () => cards };
    const opts = { now: () => t, ttlMs: 100, staleMs: 1_000 };
    expect((await loadClaudeCatalog(caller, deps, opts)).map((a) => a.slug)).toEqual(["a1"]);
    t = 500; // stale, not expired
    expect((await loadClaudeCatalog(caller, deps, opts)).map((a) => a.slug)).toEqual(["a1"]);
    await sleep(10);
    expect((await loadClaudeCatalog(caller, deps, opts)).map((a) => a.slug)).toEqual(["a2"]);
  });
});

describe("catalog keeps an app's last cards when a refetch fails", () => {
  it("a republished app whose manifest fetch fails (rate limit) stays in the catalog", async () => {
    clearCatalogCache();
    let updatedAt = "2026-10-13T04:00:00Z";
    let fail = false;
    const deps = {
      listAccessibleApps: async () => [{ ...app("scenario"), updatedAt }],
      loadCardsManifest: async () => { if (fail) throw new Error("403 rate limit"); return cards; },
    };
    expect((await loadClaudeCatalog(caller, deps, { ttlMs: 0 })).map((a) => a.slug)).toEqual(["scenario"]);
    updatedAt = "2026-10-13T04:51:00Z"; fail = true;
    const after = await loadClaudeCatalog(caller, deps, { ttlMs: 0, staleMs: 0 });
    expect(after.map((a) => a.slug)).toEqual(["scenario"]);
    expect(after[0].updatedAt).toBe("2026-10-13T04:51:00Z");
  });
});

describe("withSvgNs", () => {
  it("adds xmlns so a data: URL <img> renders (many app icons omit it)", async () => {
    const { withSvgNs } = await import("./catalog.js");
    expect(withSvgNs('<svg viewBox="0 0 48 48"><path/></svg>')).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path/></svg>');
    const ok = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>';
    expect(withSvgNs(ok)).toBe(ok);
  });
});
