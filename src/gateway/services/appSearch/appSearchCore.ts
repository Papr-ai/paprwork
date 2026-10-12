/**
 * App search: a mini-app's items (videos, leads, docs...) indexed in Papr Memory so Claude
 * and the app itself can find them by meaning, not exact title.
 *
 * Each item is one memory. Exact-match customMetadata ties it to the app; one JSON field
 * carries what a caller needs to open it (id, title, card view + args, deep link).
 *
 *   content_type  papr_app_item          papr_item_key  ns/slug/id (upsert key)
 *   papr_app_ns   publisher namespace     papr_item      JSON {id,title,view,args,url,updatedAt,appId}
 *   papr_app_slug published slug
 *
 * Keep the key set small and fixed: the memory server creates a vector-store payload index
 * for every distinct customMetadata key it sees.
 *
 * Pure functions only: no network, no SDK. The transports live in appSearchMemory.ts.
 */

export const APP_ITEM_CONTENT_TYPE = "papr_app_item";
export const MAX_ITEMS_PER_CALL = 100;

export type ArgValue = string | number | boolean;

export interface AppSearchItem {
  /** Stable id in the app (a row id). Re-indexing the same id replaces it. */
  id: string;
  title: string;
  /** What to match on: description, transcript, tags. Longer is fine (capped). */
  text?: string;
  /** Card view that opens the item, e.g. "library". */
  view?: string;
  /** Arguments for that view's tool, e.g. { video: "v_123" }. */
  args?: Record<string, ArgValue>;
  /** App-relative deep link, e.g. "?video=v_123". */
  url?: string;
  updatedAt?: string;
}

export interface AppRef {
  namespaceId: string;
  slug: string;
  appId?: string;
  title?: string;
}

export interface AppSearchHit {
  namespaceId: string;
  slug: string;
  id: string;
  title: string;
  snippet: string;
  view?: string;
  args?: Record<string, ArgValue>;
  url?: string;
  memoryId?: string;
}

export class AppSearchError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const PART = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const VIEW = /^[a-z][a-z0-9-]{0,40}$/;
const TEXT_MAX = 8000;
const SNIPPET_MAX = 240;

const str = (v: unknown, field: string, max: number, required: boolean): string | undefined => {
  if (v === undefined || v === null || v === "") {
    if (required) throw new AppSearchError(`${field} is required`);
    return undefined;
  }
  if (typeof v !== "string" && typeof v !== "number") throw new AppSearchError(`${field} must be a string`);
  const s = String(v).trim();
  if (required && !s) throw new AppSearchError(`${field} is required`);
  if (s.length > max) throw new AppSearchError(`${field} is longer than ${max} characters`);
  return s || undefined;
};

export function assertAppRef(app: AppRef): void {
  if (!PART.test(app.namespaceId) || !PART.test(app.slug)) throw new AppSearchError("Invalid app reference");
}

/** Checks and normalizes items from an untrusted caller. Long text is cut, not rejected. */
export function validateItems(raw: unknown): AppSearchItem[] {
  if (!Array.isArray(raw)) throw new AppSearchError("items must be an array");
  if (raw.length > MAX_ITEMS_PER_CALL) throw new AppSearchError(`At most ${MAX_ITEMS_PER_CALL} items per call`);
  const seen = new Set<string>();
  return raw.map((r, i) => {
    if (!r || typeof r !== "object") throw new AppSearchError(`items[${i}] must be an object`);
    const o = r as Record<string, unknown>;
    const id = str(o.id, `items[${i}].id`, 200, true)!;
    if (seen.has(id)) throw new AppSearchError(`Duplicate item id ${id}`);
    seen.add(id);
    const view = str(o.view, `items[${i}].view`, 41, false);
    if (view && !VIEW.test(view)) throw new AppSearchError(`items[${i}].view is not a card view name`);
    let args: Record<string, ArgValue> | undefined;
    if (o.args !== undefined && o.args !== null) {
      if (typeof o.args !== "object" || Array.isArray(o.args)) throw new AppSearchError(`items[${i}].args must be an object`);
      args = {};
      for (const [k, v] of Object.entries(o.args)) {
        if (!["string", "number", "boolean"].includes(typeof v)) throw new AppSearchError(`items[${i}].args.${k} must be a string, number or boolean`);
        args[k] = v as ArgValue;
      }
      if (JSON.stringify(args).length > 2000) throw new AppSearchError(`items[${i}].args is too large`);
    }
    const text = typeof o.text === "string" ? o.text.trim().slice(0, TEXT_MAX) : undefined;
    const url = str(o.url, `items[${i}].url`, 1000, false);
    const updatedAt = str(o.updatedAt, `items[${i}].updatedAt`, 40, false);
    return {
      id,
      title: str(o.title, `items[${i}].title`, 300, true)!,
      ...(text ? { text } : {}),
      ...(view ? { view } : {}),
      ...(args ? { args } : {}),
      ...(url ? { url } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    };
  });
}

export const itemKey = (app: AppRef, id: string): string => `${app.namespaceId}/${app.slug}/${id}`;

/** Filter for one app's items, or all app items when no app is given. */
export function appItemFilter(app?: Pick<AppRef, "namespaceId" | "slug">): Record<string, string> {
  return {
    content_type: APP_ITEM_CONTENT_TYPE,
    ...(app ? { papr_app_ns: app.namespaceId, papr_app_slug: app.slug } : {}),
  };
}

export function buildItemMemory(app: AppRef, item: AppSearchItem): { content: string; customMetadata: Record<string, string> } {
  const content = [item.title, app.title ? `In ${app.title}` : "", item.text ?? ""].filter(Boolean).join("\n");
  const packed = {
    id: item.id,
    title: item.title,
    ...(item.view ? { view: item.view } : {}),
    ...(item.args ? { args: item.args } : {}),
    ...(item.url ? { url: item.url } : {}),
    ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
    ...(app.appId ? { appId: app.appId } : {}),
  };
  return {
    content,
    customMetadata: { ...appItemFilter(app), papr_item_key: itemKey(app, item.id), papr_item: JSON.stringify(packed) },
  };
}

export interface MemoryHitLike {
  id?: string | null;
  content?: string | null;
  customMetadata?: Record<string, unknown> | null;
}

const parseObj = <T extends object>(raw: unknown): T | undefined => {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as T) : undefined;
  } catch {
    return undefined;
  }
};

interface Packed { id?: string; title?: string; view?: string; args?: Record<string, ArgValue>; url?: string }

/** Memory results (best first) → one hit per item. Non-app memories are ignored. */
export function parseHits(memories: readonly MemoryHitLike[], limit: number): AppSearchHit[] {
  const out: AppSearchHit[] = [];
  const seen = new Set<string>();
  for (const m of memories) {
    const meta = m.customMetadata ?? {};
    if (meta.content_type !== APP_ITEM_CONTENT_TYPE) continue;
    // papr_item (JSON) today; the separate papr_item_* keys from the first release still parse.
    const p: Packed = parseObj<Packed>(meta.papr_item) ?? {
      id: meta.papr_item_id as string | undefined,
      title: meta.papr_item_title as string | undefined,
      view: meta.papr_item_view as string | undefined,
      args: parseObj<Record<string, ArgValue>>(meta.papr_item_args),
      url: meta.papr_item_url as string | undefined,
    };
    const ns = String(meta.papr_app_ns ?? ""), slug = String(meta.papr_app_slug ?? ""), id = String(p.id ?? "");
    if (!ns || !slug || !id) continue;
    const key = `${ns}/${slug}/${id}`;
    if (seen.has(key)) continue; // a stale copy mid-reindex, or a chunk of a long item
    seen.add(key);
    const title = String(p.title ?? "") || (m.content ?? "").split("\n")[0] || id;
    const body = (m.content ?? "").split("\n").slice(1).filter((l) => !l.startsWith("In ")).join(" ").trim();
    const args = p.args && typeof p.args === "object" ? p.args : undefined;
    out.push({
      namespaceId: ns,
      slug,
      id,
      title,
      snippet: body.length > SNIPPET_MAX ? `${body.slice(0, SNIPPET_MAX - 1)}…` : body,
      ...(typeof p.view === "string" ? { view: p.view } : {}),
      ...(args ? { args } : {}),
      ...(typeof p.url === "string" ? { url: p.url } : {}),
      ...(m.id ? { memoryId: m.id } : {}),
    });
    if (out.length >= limit) break;
  }
  return out;
}
