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
import type { CardsManifest, CardsManifestView } from "./cardBuild.js";

export interface AccessibleApp {
  appId: string;
  namespaceId: string;
  slug: string;
  name?: string;
  description?: string;
  author?: string;
  updatedAt?: string;
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
  now?: () => number;
}

const VIEW_NAME = /^[a-z][a-z0-9-]{0,40}$/;
const KINDS = new Set(["status", "action", "approval"]);

/** Defensive parse: cards.json is app-repo content, so treat it as untrusted. */
export function parseCardsManifest(raw: unknown): CardsManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { version?: unknown; summary?: unknown; views?: unknown };
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
      ...(view.actionSpec && typeof view.actionSpec === "object" ? { actionSpec: view.actionSpec } : {}),
    };
  }
  if (Object.keys(views).length === 0) return null;
  const summary = typeof r.summary === "string" && r.summary.trim() ? r.summary.trim().slice(0, 300) : undefined;
  return { version: 1, ...(summary ? { summary } : {}), views };
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

export function clearCatalogCache(): void {
  cache.clear();
}

export async function loadClaudeCatalog(caller: McpCaller, deps: CatalogDeps, opts: CatalogOptions = {}): Promise<ClaudeApp[]> {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? 60_000;
  const hit = cache.get(caller.userId);
  if (hit && now() - hit.at < ttl) return hit.apps;

  const accessible = (await deps.listAccessibleApps(caller))
    .filter((a) => a.namespaceId && a.slug)
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
    .slice(0, opts.maxApps ?? 50);

  const loaded = await mapLimit(accessible, opts.concurrency ?? 8, async (app) => {
    try {
      const cards = parseCardsManifest(await deps.loadCardsManifest(caller, app));
      return cards ? { ...app, cards } : null;
    } catch {
      return null; // one broken or forbidden app never hides the rest
    }
  });
  const apps = loaded.filter((a): a is ClaudeApp => a !== null);

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
    }));
  };
}
