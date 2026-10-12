import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { APP_ITEM_CONTENT_TYPE, AppSearchError, buildItemMemory, parseHits, validateItems, type AppRef } from "./appSearchCore.js";
import { httpMemoryPort, indexItems, queryItems, removeItems, type MemoryPort } from "./appSearchMemory.js";
import { clearAppSearchRefCache, refFromShareUrl, registerAppSearchRoutes } from "./appSearchRoutes.js";
import type { MemoryHitLike } from "./appSearchCore.js";

const APP: AppRef = { namespaceId: "85ZIB7mD1V", slug: "scenario", appId: "e7bd", title: "Scenario" };
const VIDEOS = [
  { id: "v1", title: "This Was the Deck", text: "A 60 second pitch: the deck we stopped using", view: "library", args: { video: "v1" }, url: "?video=v1" },
  { id: "v2", title: "Memory, Inside Claude", text: "Papr memory working inside Claude", view: "library", args: { video: "v2" } },
];

/** In-memory stand-in for Papr Memory: exact customMetadata filter + naive word-overlap ranking. */
function fakeMemory(): MemoryPort & { rows: Map<string, MemoryHitLike> } {
  const rows = new Map<string, MemoryHitLike>();
  let n = 0;
  const words = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  return {
    rows,
    async add(content, customMetadata) {
      const id = `m${++n}`;
      rows.set(id, { id, content, customMetadata });
      return id;
    },
    async search(query, filter, max) {
      const q = words(query);
      return [...rows.values()]
        .filter((r) => Object.entries(filter).every(([k, v]) => r.customMetadata?.[k] === v))
        .map((r) => ({ r, score: [...words(r.content ?? "")].filter((w) => q.has(w)).length }))
        .sort((a, b) => b.score - a.score)
        .slice(0, max)
        .map((x) => x.r);
    },
    async remove(id) {
      rows.delete(id);
    },
  };
}

describe("validateItems", () => {
  it("normalizes good items and rejects bad ones", () => {
    expect(validateItems([{ id: 7, title: " A ", text: "x".repeat(9000) }])[0]).toMatchObject({ id: "7", title: "A" });
    expect(validateItems([{ id: "a", title: "A", text: "x".repeat(9000) }])[0].text).toHaveLength(8000);
    expect(() => validateItems([{ id: "a" }])).toThrow(AppSearchError);
    expect(() => validateItems([{ id: "a", title: "A" }, { id: "a", title: "B" }])).toThrow(/Duplicate/);
    expect(() => validateItems([{ id: "a", title: "A", args: { x: { y: 1 } } }])).toThrow(/args.x/);
    expect(() => validateItems([{ id: "a", title: "A", view: "Bad View" }])).toThrow(/view/);
    expect(() => validateItems(Array.from({ length: 101 }, (_, i) => ({ id: `${i}`, title: "t" })))).toThrow(/100/);
  });
});

describe("buildItemMemory / parseHits", () => {
  it("round-trips the open info and skips non-app memories and duplicates", () => {
    const m = buildItemMemory(APP, validateItems([VIDEOS[0]])[0]);
    expect(m.customMetadata).toMatchObject({ content_type: APP_ITEM_CONTENT_TYPE, papr_app_slug: "scenario", papr_item_key: "85ZIB7mD1V/scenario/v1" });
    const hits = parseHits([{ id: "x", content: "a chat note", customMetadata: {} }, { id: "m1", ...m }, { id: "m2", ...m }], 5);
    expect(hits).toEqual([{
      namespaceId: "85ZIB7mD1V", slug: "scenario", id: "v1", title: "This Was the Deck",
      snippet: "A 60 second pitch: the deck we stopped using", view: "library", args: { video: "v1" }, url: "?video=v1", memoryId: "m1",
    }]);
  });
});

describe("index / query / remove", () => {
  it("finds the deck video from a loose phrase, and re-indexing replaces instead of duplicating", async () => {
    const mem = fakeMemory();
    expect(await indexItems(mem, APP, VIDEOS)).toEqual({ indexed: 2, replaced: 0, failed: [] });
    expect(await indexItems(mem, APP, [{ ...VIDEOS[0], text: "the deck, updated" }])).toMatchObject({ indexed: 1, replaced: 1 });
    expect(mem.rows.size).toBe(2);
    const [top] = await queryItems(mem, "this is the deck", { app: APP });
    expect(top).toMatchObject({ id: "v1", args: { video: "v1" } });
    expect(await removeItems(mem, APP, ["v1"])).toEqual({ removed: 1 });
    expect((await queryItems(mem, "deck", { app: APP })).map((h) => h.id)).toEqual(["v2"]);
  });

  it("keeps the old entry when the new add fails", async () => {
    const mem = fakeMemory();
    await indexItems(mem, APP, [VIDEOS[0]]);
    const add = mem.add;
    mem.add = async () => { throw new Error("memory down"); };
    expect((await indexItems(mem, APP, [VIDEOS[0]])).failed).toEqual([{ id: "v1", error: "memory down" }]);
    mem.add = add;
    expect(mem.rows.size).toBe(1);
  });

  it("scopes to one app", async () => {
    const mem = fakeMemory();
    await indexItems(mem, APP, VIDEOS);
    await indexItems(mem, { namespaceId: "85ZIB7mD1V", slug: "outreach" }, [{ id: "l1", title: "Deck follow-up lead" }]);
    expect((await queryItems(mem, "deck", { app: { namespaceId: "85ZIB7mD1V", slug: "outreach" } })).map((h) => h.id)).toEqual(["l1"]);
    expect((await queryItems(mem, "deck", { limit: 10 })).length).toBe(3);
  });
});

describe("httpMemoryPort", () => {
  it("calls memory as the caller with the exact-match filter", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: { memories: [{ id: "m1", content: "T", customMetadata: { content_type: APP_ITEM_CONTENT_TYPE } }] } }), { status: 200 });
    }) as unknown as typeof fetch;
    const port = httpMemoryPort("https://memory.example/", { sessionToken: "s1" }, fetchImpl);
    await port.search("deck", { content_type: APP_ITEM_CONTENT_TYPE }, 15);
    expect(calls[0].url).toBe("https://memory.example/v1/memory/search?max_memories=15&max_nodes=10");
    expect((calls[0].init.headers as Record<string, string>)["X-Session-Token"]).toBe("s1");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ query: "deck", metadata: { customMetadata: { content_type: APP_ITEM_CONTENT_TYPE } } });
  });
});

describe("/api/search routes", () => {
  let close: (() => void) | undefined;
  afterEach(() => { close?.(); clearAppSearchRefCache(); });

  const serve = async (ref: AppRef | null) => {
    const mem = fakeMemory();
    const app = express();
    app.use(express.json());
    registerAppSearchRoutes(app, {
      resolveAppId: (_req, id) => (id ? { appId: id } : { error: "appId is required", status: 400 }),
      resolveAppRef: async () => ref,
      memoryPort: async () => mem,
    });
    const server = app.listen(0);
    close = () => server.close();
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  };

  it("indexes and queries for the calling app", async () => {
    const post = await serve(APP);
    expect((await post("/api/search/index", { appId: "e7bd", items: VIDEOS })).status).toBe(200);
    const res = await post("/api/search/query", { appId: "e7bd", query: "this is the deck" });
    expect(((await res.json()) as { results: Array<{ id: string }> }).results[0].id).toBe("v1");
  });

  it("asks for a publish when the app has no link yet, and rejects bad input", async () => {
    const post = await serve(null);
    const res = await post("/api/search/index", { appId: "e7bd", items: VIDEOS });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/Publish/);
    expect((await post("/api/search/query", { query: "x" })).status).toBe(400);
  });

  it("reads namespace and slug from the share link", () => {
    expect(refFromShareUrl("https://apps.papr.ai/85ZIB7mD1V/scenario/")).toEqual({ namespaceId: "85ZIB7mD1V", slug: "scenario" });
    expect(refFromShareUrl(null)).toBeNull();
  });
});
