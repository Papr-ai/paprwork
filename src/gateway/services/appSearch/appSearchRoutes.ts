/**
 * Desktop gateway: /api/search/* for mini-apps, their backend actions and jobs.
 *
 *   POST /api/search/index   { items: AppSearchItem[] }   upsert by item id
 *   POST /api/search/remove  { ids: string[] }
 *   POST /api/search/query   { query, limit?, allApps? }  this app's items (or all apps')
 *
 * appId comes from the iframe (or an explicit body.appId for jobs), like /api/db/*.
 * Items are keyed by the app's published namespace/slug, because that's what Claude sees,
 * so indexing needs the app published once.
 */
import type { Express, Request, Response } from "express";
import { AppSearchError, type AppRef } from "./appSearchCore.js";
import { desktopMemoryPort, indexItems, queryItems, removeItems, type MemoryPort } from "./appSearchMemory.js";

export interface AppSearchRouteDeps {
  resolveAppId(req: Request, explicitAppId: string | undefined): { appId: string } | { error: string; status: number };
  /** Published namespace/slug (+ title) for an app, or null when it was never published. */
  resolveAppRef?(appId: string): Promise<AppRef | null>;
  memoryPort?(): Promise<MemoryPort>;
}

const REF_TTL_MS = 10 * 60_000;
const refCache = new Map<string, { ref: AppRef | null; at: number }>();

/** apps.papr.ai/{namespaceId}/{slug}/ → { namespaceId, slug } */
export function refFromShareUrl(shareUrl: string | null | undefined): Pick<AppRef, "namespaceId" | "slug"> | null {
  if (!shareUrl) return null;
  try {
    const [namespaceId, slug] = new URL(shareUrl).pathname.split("/").filter(Boolean);
    return namespaceId && slug ? { namespaceId, slug } : null;
  } catch {
    return null;
  }
}

async function defaultResolveAppRef(appId: string): Promise<AppRef | null> {
  const { getCloudAppPublishService } = await import("../CloudAppPublishService.js");
  const { getAppService } = await import("../AppService.js");
  const [config, app] = await Promise.all([
    getCloudAppPublishService().getPublishConfig(appId),
    getAppService().getApp(appId).catch(() => null),
  ]);
  const ref = refFromShareUrl(config.shareUrl);
  if (!ref) return null;
  return { ...ref, ...(config.slug ? { slug: config.slug } : {}), appId, ...(app?.title ? { title: app.title } : {}) };
}

export function registerAppSearchRoutes(app: Express, deps: AppSearchRouteDeps): void {
  const resolveRef = deps.resolveAppRef ?? defaultResolveAppRef;
  const port = deps.memoryPort ?? desktopMemoryPort;

  const appRefFor = async (req: Request): Promise<AppRef> => {
    const resolved = deps.resolveAppId(req, (req.body as { appId?: string } | undefined)?.appId);
    if ("error" in resolved) throw new AppSearchError(resolved.error, resolved.status);
    const hit = refCache.get(resolved.appId);
    if (hit && Date.now() - hit.at < REF_TTL_MS && hit.ref) return hit.ref;
    const ref = await resolveRef(resolved.appId);
    refCache.set(resolved.appId, { ref, at: Date.now() });
    if (!ref) throw new AppSearchError("Publish this app once so its search results can open in Claude.", 409);
    return ref;
  };

  const handle = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      const status = err instanceof AppSearchError ? err.status : 500;
      res.status(status).json({ error: (err as Error).message });
    }
  };

  app.post("/api/search/index", handle(async (req) => {
    const ref = await appRefFor(req);
    return indexItems(await port(), ref, (req.body as { items?: unknown }).items);
  }));

  app.post("/api/search/remove", handle(async (req) => {
    const ref = await appRefFor(req);
    return removeItems(await port(), ref, (req.body as { ids?: unknown }).ids);
  }));

  app.post("/api/search/query", handle(async (req) => {
    const body = req.body as { query?: unknown; limit?: number; allApps?: boolean };
    const ref = body.allApps ? undefined : await appRefFor(req);
    return { results: await queryItems(await port(), body.query, { app: ref, limit: body.limit }) };
  }));
}

/** Tests only. */
export function clearAppSearchRefCache(): void {
  refCache.clear();
}
