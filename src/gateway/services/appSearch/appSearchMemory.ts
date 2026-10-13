/**
 * App search over Papr Memory: index (upsert by item id), remove, query.
 *
 * Two ways to reach memory, same port:
 *   - desktop: the Papr SDK with the user's API key (the app's own items, written by its
 *     iframe, backend actions or jobs through /api/search/*)
 *   - MCP: plain HTTP as the signed-in Claude caller (X-Session-Token), so a search only
 *     ever returns memories that caller can read
 */
import {
  AppSearchError,
  appItemFilter,
  assertAppRef,
  buildItemMemory,
  itemKey,
  parseHits,
  validateItems,
  type AppRef,
  type AppSearchHit,
  type MemoryHitLike,
} from "./appSearchCore.js";

export interface MemoryPort {
  add(content: string, customMetadata: Record<string, string>): Promise<string | null>;
  search(query: string, customMetadata: Record<string, string>, max: number): Promise<MemoryHitLike[]>;
  remove(memoryId: string): Promise<void>;
}

/** Memory's search floor is 10; ask for headroom so de-duplication still fills `limit`. */
const searchSize = (limit: number): number => Math.min(50, Math.max(10, limit * 3));

async function existingIds(memory: MemoryPort, app: AppRef, id: string, title: string): Promise<string[]> {
  const hits = await memory.search(title || id, { ...appItemFilter(app), papr_item_key: itemKey(app, id) }, 10);
  return hits.filter((h) => h.customMetadata?.papr_item_key === itemKey(app, id) && h.id).map((h) => h.id!);
}

export interface IndexResult {
  indexed: number;
  replaced: number;
  failed: Array<{ id: string; error: string }>;
}

/** Upsert: drop the item's previous memory (if any), then add the new one. */
export async function indexItems(memory: MemoryPort, app: AppRef, rawItems: unknown, concurrency = 4): Promise<IndexResult> {
  assertAppRef(app);
  const items = validateItems(rawItems);
  const result: IndexResult = { indexed: 0, replaced: 0, failed: [] };
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++];
      try {
        const stale = await existingIds(memory, app, item.id, item.title);
        const { content, customMetadata } = buildItemMemory(app, item);
        await memory.add(content, customMetadata);
        // Remove after adding, so a failed add never leaves the item unsearchable.
        await Promise.all(stale.map((m) => memory.remove(m).catch(() => undefined)));
        result.indexed++;
        result.replaced += stale.length ? 1 : 0;
      } catch (err) {
        result.failed.push({ id: item.id, error: (err as Error).message.slice(0, 200) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return result;
}

export async function removeItems(memory: MemoryPort, app: AppRef, ids: unknown): Promise<{ removed: number }> {
  assertAppRef(app);
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== "string" || !i)) throw new AppSearchError("ids must be an array of strings");
  let removed = 0;
  for (const id of ids as string[]) {
    for (const m of await existingIds(memory, app, id, id)) {
      await memory.remove(m);
      removed++;
    }
  }
  return { removed };
}

export async function queryItems(
  memory: MemoryPort,
  query: unknown,
  opts: { app?: Pick<AppRef, "namespaceId" | "slug">; limit?: number } = {},
): Promise<AppSearchHit[]> {
  const q = typeof query === "string" ? query.trim() : "";
  if (!q) throw new AppSearchError("query is required");
  if (q.length > 500) throw new AppSearchError("query is longer than 500 characters");
  if (opts.app) assertAppRef(opts.app as AppRef);
  const limit = Math.min(20, Math.max(1, Math.floor(opts.limit ?? 5)));
  return parseHits(await memory.search(q, appItemFilter(opts.app), searchSize(limit)), limit);
}

// ---- transports -------------------------------------------------------------------------

interface SearchJson {
  data?: { memories?: MemoryHitLike[] | null } | null;
}

/** Memory REST as one caller. Used by the MCP host with the caller's minted session. */
export function httpMemoryPort(
  baseUrl: string,
  auth: { sessionToken: string },
  fetchImpl: typeof fetch = fetch,
): MemoryPort {
  const root = baseUrl.replace(/\/$/, "");
  const headers = { "content-type": "application/json", accept: "application/json", "X-Session-Token": auth.sessionToken };
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await fetchImpl(`${root}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404 && (method === "DELETE" || path.startsWith("/v1/memory/search"))) return null;
    if (!res.ok) throw new AppSearchError(`Papr memory ${method} ${path.split("?")[0]} failed (HTTP ${res.status})`, res.status >= 500 ? 502 : res.status);
    return res.status === 204 ? null : res.json().catch(() => null);
  };
  return {
    async add(content, customMetadata) {
      const out = (await call("POST", "/v1/memory", { content, type: "text", metadata: { customMetadata } })) as {
        data?: Array<{ memoryId?: string }> | null;
      } | null;
      return out?.data?.[0]?.memoryId ?? null;
    },
    async search(query, customMetadata, max) {
      const out = (await call("POST", `/v1/memory/search?max_memories=${max}&max_nodes=10`, {
        query,
        rank_results: false,
        metadata: { customMetadata },
      })) as SearchJson | null;
      return out?.data?.memories ?? [];
    },
    async remove(memoryId) {
      await call("DELETE", `/v1/memory/${encodeURIComponent(memoryId)}`);
    },
  };
}

/** Desktop: the Papr SDK with the user's API key and the workspace's memory scope. */
export async function desktopMemoryPort(): Promise<MemoryPort> {
  const { getPaprClient, isPaprNotFoundError } = await import("../../../core/tools/paprClient.js");
  const { paprMemoryScopeSpread, paprMemorySearchScopeSpread } = await import("../../utils/memoryScopeResolver.js");
  const client = await getPaprClient();
  return {
    async add(content, customMetadata) {
      const res = await client.memory.add({ content, type: "text", metadata: { customMetadata }, ...(await paprMemoryScopeSpread()) } as never);
      return (res as { data?: Array<{ memoryId?: string }> | null }).data?.[0]?.memoryId ?? null;
    },
    async search(query, customMetadata, max) {
      const res = await client.memory.search({
        query,
        max_memories: max,
        max_nodes: 10,
        rank_results: false,
        metadata: { customMetadata },
        ...(await paprMemorySearchScopeSpread()),
      } as never).catch((err: unknown) => {
        // Memory answers 404 "No relevant items found" when nothing matches: that's an empty result.
        if (isPaprNotFoundError(err)) return null;
        throw err;
      });
      return ((res as SearchJson | null)?.data?.memories ?? []) as MemoryHitLike[];
    },
    async remove(memoryId) {
      await client.memory.delete(memoryId).catch((err: unknown) => {
        if (!isPaprNotFoundError(err)) throw err;
      });
    },
  };
}
