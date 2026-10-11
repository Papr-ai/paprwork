/**
 * Which Papr apps a signed-in Claude user can open as cards.
 *
 *   1. memory: apps the caller can read (own private + team + public), across workspaces
 *   2. per app: dist/cards/cards.json through the host's app-file route, as the caller
 *      (so access is checked twice, by the same rules as apps.papr.ai)
 *   3. keep the ones with cards
 *
 * Cached per user for a minute: Claude calls tools/list often, and per-app tools only
 * change when someone publishes.
 */
import type { McpCaller } from "./auth.js";
import { gcsCacheGet, gcsCachePut } from "../appRuntime/gcsSharedCache.js";
import type { CardsManifest, CardsManifestView } from "./cardBuild.js";

export interface AccessibleApp {
  appId: string;
  namespaceId: string;
  slug: string;
  name?: string;
  description?: string;
  author?: string;
  updatedAt?: string;
  /** Monochrome SVG markup from the app's metadata, when the memory server sends it. */
  icon?: string;
}

export interface ClaudeApp extends AccessibleApp {
  cards: CardsManifest;
}

export interface CatalogDeps {
  listAccessibleApps(caller: McpCaller): Promise<AccessibleApp[]>;
  loadCardsManifest(caller: McpCaller, ref: { namespaceId: string; slug: string }): Promise<unknown | null>;
}

export interface CatalogOptions {
  /** Apps whose cards.json is checked, most recently published first. */
  maxApps?: number;
  concurrency?: number;
  ttlMs?: number;
  /** How long a stale catalog is still served while a refresh runs. */
  staleMs?: number;
  /** Per-app cards.json budget; a slow app is skipped, never waited on. */
  manifestTimeoutMs?: number;
  now?: () => number;
}

const VIEW_NAME = /^[a-z][a-z0-9-]{0,40}$/;
const KINDS = new Set(["status", "action", "approval"]);

/** Defensive parse: cards.json is app-repo content, so treat it as untrusted. */
export function parseCardsManifest(raw: unknown): CardsManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { version?: unknown; summary?: unknown; whenToUse?: unknown; examples?: unknown; views?: unknown };
  const list = (x: unknown, n: number): string[] | undefined => {
    if (!Array.isArray(x)) return undefined;
    const out = x.filter((e): e is string => typeof e === "string" && !!e.trim()).map((e) => e.trim().slice(0, 120)).slice(0, n);
    return out.length ? out : undefined;
  };
  if (r.version !== 1 || !r.views || typeof r.views !== "object") return null;
  const views: Record<string, CardsManifestView> = {};
  for (const [name, v] of Object.entries(r.views as Record<string, unknown>)) {
    if (!VIEW_NAME.test(name) || !v || typeof v !== "object") continue;
    const view = v as Partial<CardsManifestView>;
    if (view.file !== `${name}.html`) continue;
    if (view.kind !== undefined && !KINDS.has(view.kind)) continue;
    const str = (x: unknown, max: number): string | undefined =>
      typeof x === "string" && x.trim() ? x.trim().slice(0, max) : undefined;
    views[name] = {
      file: view.file,
      bytes: typeof view.bytes === "number" ? view.bytes : 0,
      ...(view.kind ? { kind: view.kind } : {}),
      ...(view.entry ? { entry: str(view.entry, 200) } : {}),
      ...(str(view.from, 64) ? { from: str(view.from, 64) } : {}),
      ...(str(view.action, 64) ? { action: str(view.action, 64) } : {}),
      ...(str(view.title, 80) ? { title: str(view.title, 80) } : {}),
      ...(str(view.description, 300) ? { description: str(view.description, 300) } : {}),
      ...(str(view.whenToUse, 280) ? { whenToUse: str(view.whenToUse, 280) } : {}),
      ...(list(view.examples, 4) ? { examples: list(view.examples, 4) } : {}),
      ...(view.actionSpec && typeof view.actionSpec === "object" ? { actionSpec: view.actionSpec } : {}),
    };
  }
  if (Object.keys(views).length === 0) return null;
  const summary = typeof r.summary === "string" && r.summary.trim() ? r.summary.trim().slice(0, 300) : undefined;
  const whenToUse = typeof r.whenToUse === "string" && r.whenToUse.trim() ? r.whenToUse.trim().slice(0, 280) : undefined;
  const examples = list(r.examples, 6);
  return { version: 1, ...(summary ? { summary } : {}), ...(whenToUse ? { whenToUse } : {}), ...(examples ? { examples } : {}), views };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const cache = new Map<string, { at: number; apps: ClaudeApp[] }>();
const MAX_CACHED_USERS = 2000;

/**
 * cards.json per published version ("ns/slug@updatedAt" → manifest or null). Only answers
 * (incl. "no cards") are kept, never errors/timeouts. Each user's list is already access-
 * filtered by memory, so sharing this across users reveals nothing; it turns every rebuild
 * after the first into lookups for changed apps only (the cold build hit memory's 120/min limit).
 */
const manifests = new Map<string, CardsManifest | null>();
const MAX_MANIFESTS = 20_000;

export function clearCatalogCache(): void {
  cache.clear();
  inflight.clear();
  manifests.clear();
  restored = null;
}

/**
 * The memo survives restarts/deploys in the host's GCS cache bucket, so the first Claude
 * connect after a deploy is fast too (a cold build is ~40s and Claude stops waiting at ~7s).
 */
const MEMO_KEY = "mcp/cards-manifests-v1.json";
let restored: Promise<void> | null = null;
function restoreMemo(): Promise<void> {
  restored ??= withTimeout(gcsCacheGet(MEMO_KEY), 3_000)
    .then((f) => {
      if (!f) return;
      for (const [k, v] of Object.entries(JSON.parse(f.content) as Record<string, unknown>)) {
        if (!manifests.has(k)) manifests.set(k, v === null ? null : parseCardsManifest(v));
      }
      console.log(`[mcp] restored ${manifests.size} card manifests from cache`);
    })
    .catch(() => undefined);
  return restored;
}
function saveMemo(): void {
  gcsCachePut(MEMO_KEY, { content: JSON.stringify(Object.fromEntries(manifests)), contentType: "application/json" }, Date.now() + 365 * 86_400_000);
}

const inflight = new Map<string, Promise<ClaudeApp[]>>();

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** One build per user at a time: Claude retries fast, and piled-up builds hit memory rate limits. */
export function loadClaudeCatalog(caller: McpCaller, deps: CatalogDeps, opts: CatalogOptions = {}): Promise<ClaudeApp[]> {
  const now = opts.now ?? Date.now;
  const hit = cache.get(caller.userId);
  const age = hit ? now() - hit.at : Infinity;
  if (hit && age < (opts.ttlMs ?? 5 * 60_000)) return Promise.resolve(hit.apps);
  let running = inflight.get(caller.userId);
  if (!running) {
    const started = Date.now();
    running = buildCatalog(caller, deps, opts)
      .then((apps) => {
        console.log(`[mcp] app catalog ready: ${apps.length} apps with cards in ${Date.now() - started}ms`);
        return apps;
      })
      .finally(() => inflight.delete(caller.userId));
    inflight.set(caller.userId, running);
  }
  // Stale-while-revalidate: a day-old list beats an empty one; the refresh runs behind it.
  if (hit && age < (opts.staleMs ?? 24 * 60 * 60_000)) {
    running.catch(() => undefined);
    return Promise.resolve(hit.apps);
  }
  return running;
}

/**
 * Catalog for a live request, never slower than budgetMs. If the build is still running,
 * answer with the last catalog (or none) and let it finish in the background for next time.
 */
export async function loadClaudeCatalogWithin(
  caller: McpCaller,
  deps: CatalogDeps,
  budgetMs: number,
  opts: CatalogOptions = {},
): Promise<{ apps: ClaudeApp[]; complete: boolean }> {
  const p = loadClaudeCatalog(caller, deps, opts);
  try {
    return { apps: await withTimeout(p, budgetMs), complete: true };
  } catch (err) {
    p.catch(() => undefined);
    if (!(err instanceof Error) || !err.message.startsWith("timed out")) throw err;
    return { apps: cache.get(caller.userId)?.apps ?? [], complete: false };
  }
}

async function buildCatalog(caller: McpCaller, deps: CatalogDeps, opts: CatalogOptions): Promise<ClaudeApp[]> {
  const now = opts.now ?? Date.now;
  const accessible = (await deps.listAccessibleApps(caller))
    .filter((a) => a.namespaceId && a.slug)
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
    .slice(0, opts.maxApps ?? 50);

  const manifestMs = opts.manifestTimeoutMs ?? 5_000;
  await restoreMemo();
  let learned = false;
  const loaded = await mapLimit(accessible, opts.concurrency ?? 4, async (app) => {
    const key = app.updatedAt ? `${app.namespaceId}/${app.slug}@${app.updatedAt}` : "";
    try {
      let cards = key ? manifests.get(key) : undefined;
      if (cards === undefined) {
        cards = parseCardsManifest(await withTimeout(deps.loadCardsManifest(caller, app), manifestMs));
        if (key) {
          if (manifests.size >= MAX_MANIFESTS) manifests.delete(manifests.keys().next().value as string);
          manifests.set(key, cards);
          learned = true;
        }
      }
      return cards ? { ...app, cards } : null;
    } catch {
      return null; // one broken, slow or forbidden app never hides the rest
    }
  });
  const apps = loaded.filter((a): a is ClaudeApp => a !== null);
  if (learned) saveMemo();

  if (cache.size >= MAX_CACHED_USERS) cache.delete(cache.keys().next().value as string);
  cache.set(caller.userId, { at: now(), apps });
  return apps;
}

/** memory: GET /v1/cloud/apps/accessible (all workspaces, as the caller). */
export function memoryAccessibleApps(baseUrl: string, fetchImpl: typeof fetch = fetch): CatalogDeps["listAccessibleApps"] {
  return async (caller) => {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/v1/cloud/apps/accessible`, {
      headers: { accept: "application/json", "X-Session-Token": caller.sessionToken },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Papr app list unavailable (HTTP ${res.status})`);
    const data = (await res.json()) as { apps?: Array<Record<string, unknown>> };
    return (data.apps ?? []).map((a) => ({
      appId: String(a.appId ?? ""),
      namespaceId: String(a.namespaceId ?? ""),
      slug: String(a.slug ?? ""),
      name: typeof a.name === "string" ? a.name : undefined,
      description: typeof a.description === "string" ? a.description : undefined,
      author: typeof a.author === "string" ? a.author : undefined,
      updatedAt: typeof a.updatedAt === "string" ? a.updatedAt : undefined,
      icon: typeof a.icon === "string" && /^\s*<svg[\s>]/i.test(a.icon) && a.icon.length < 8_000 ? a.icon : undefined,
    }));
  };
}
