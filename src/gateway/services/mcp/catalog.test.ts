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
