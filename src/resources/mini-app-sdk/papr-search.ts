/**
 * App search for mini-apps: put your items in Papr Memory once, then find them by meaning.
 * Claude finds them too (papr_search), and opens the right card with the args you give.
 *
 *   import { papr } from '/__papr__/papr-sdk.ts';
 *
 *   await papr.search.index([
 *     { id: v.id, title: v.title, text: v.transcript, view: 'library', args: { video: v.id }, url: `?video=${v.id}` },
 *   ]);
 *   const hits = await papr.search.query('the deck video');   // [{ id, title, snippet, args, ... }]
 *   await papr.search.remove([v.id]);
 *
 * Index an item again whenever it changes; the same id replaces the old entry.
 * Jobs and backend actions can POST the same routes on the desktop gateway with { appId }.
 * The app must be published once: results are keyed by its published link.
 */

export interface SearchItem {
  /** Your row id. Re-indexing the same id replaces it. */
  id: string;
  title: string;
  /** What to match on: summary, transcript, tags. Long text is cut at 8,000 characters. */
  text?: string;
  /** Claude card view that opens this item (a key of metadata.claude.views). */
  view?: string;
  /** Arguments for that view's tool, e.g. { video: id }. */
  args?: Record<string, string | number | boolean>;
  /** Deep link inside the app, e.g. "?video=v_123". */
  url?: string;
  updatedAt?: string;
}

export interface SearchHit {
  id: string;
  title: string;
  snippet: string;
  view?: string;
  args?: Record<string, string | number | boolean>;
  url?: string;
  namespaceId: string;
  slug: string;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error || `Search ${path} failed (${res.status})`);
  return json;
}

export const search = {
  /** Add or replace up to 100 items per call. */
  index(items: SearchItem[]): Promise<{ indexed: number; replaced: number; failed: Array<{ id: string; error: string }> }> {
    return post("/api/search/index", { items });
  },
  remove(ids: string[]): Promise<{ removed: number }> {
    return post("/api/search/remove", { ids });
  },
  /** Best matches first. allApps searches every app's items you can see. */
  async query(query: string, opts: { limit?: number; allApps?: boolean } = {}): Promise<SearchHit[]> {
    return (await post<{ results: SearchHit[] }>("/api/search/query", { query, ...opts })).results;
  },
};

export const papr = { search };
export default papr;
