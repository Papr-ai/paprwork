/**
 * Desktop gateway: /api/entities/* for mini-apps, their jobs and agents.
 *
 *   GET  /api/entities/manifest                     the app's validated entities.json
 *   POST /api/entities/sync     { sourceId? }       resolve all bound rows -> match report
 *   POST /api/entities/resolve  { type, match }     entity id for keys (no writes)
 *   POST /api/entities/get      { entityId } | { table, row, type? }
 *   POST /api/entities/observe  { about, text?, facts?, source? }
 *
 * appId comes from the iframe header (or body.appId for jobs), like /api/db/*.
 * Platform tables live in the bound data source; the app's own tables are only read.
 */
import type { Express, Request, Response } from "express";
import { EntitiesError, validateManifest, type EntitiesManifest, type EntityType, ENTITY_TYPES } from "./entitiesCore.js";
import { entityForRow, getEntity, observe, resolveKeys, syncManifest, type GraphPort, type SqlPort } from "./entitiesStore.js";

export interface EntitiesRouteDeps {
  resolveAppId(req: Request, explicitAppId: string | undefined): { appId: string } | { error: string; status: number };
  /** Raw entities.json for an app, or null when the app has none. */
  readManifest(appId: string): Promise<unknown | null>;
  /** SQL port bound to one of the app's data sources (by alias or id). */
  sqlPort(appId: string, sourceAlias: string): Promise<SqlPort>;
  /** Live-mode graph writer; omitted = shadow behaviour even if manifest says live. */
  graphPort?(appId: string, manifest: EntitiesManifest): Promise<GraphPort | undefined>;
}

/** Identity always resolves in the manifest's home source. */
function primarySource(manifest: EntitiesManifest, preferred?: string): string {
  if (preferred && preferred !== manifest.home) {
    throw new EntitiesError(`sourceId '${preferred}' is not this app's entity home ('${manifest.home}')`);
  }
  if (!manifest.home) throw new EntitiesError("entities.json binds no tables");
  return manifest.home;
}

function asType(v: unknown): EntityType {
  if (typeof v !== "string" || !(ENTITY_TYPES as readonly string[]).includes(v)) {
    throw new EntitiesError(`type must be one of ${ENTITY_TYPES.join(", ")}`);
  }
  return v as EntityType;
}

export function registerEntitiesRoutes(app: Express, deps: EntitiesRouteDeps): void {
  const ctx = async (req: Request) => {
    const body = (req.body ?? {}) as { appId?: string };
    const resolved = deps.resolveAppId(req, body.appId ?? (req.query.appId as string | undefined));
    if ("error" in resolved) throw new EntitiesError(resolved.error, resolved.status);
    const raw = await deps.readManifest(resolved.appId);
    if (raw === null) throw new EntitiesError("This app has no entities.json. Add one to bind its tables to a schema pack.", 404);
    return { appId: resolved.appId, manifest: validateManifest(raw) };
  };

  const handle = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      const status = err instanceof EntitiesError ? err.status : 500;
      res.status(status).json({ error: (err as Error).message });
    }
  };

  app.get("/api/entities/manifest", handle(async (req) => (await ctx(req)).manifest));

  app.post("/api/entities/sync", handle(async (req) => {
    const { appId, manifest } = await ctx(req);
    const body = req.body as { limit?: number };
    const ports = new Map<string, Promise<SqlPort>>();
    const dbFor = (alias: string) => {
      if (!ports.has(alias)) ports.set(alias, deps.sqlPort(appId, alias));
      return ports.get(alias)!;
    };
    return { home: manifest.home, ...(await syncManifest(dbFor, manifest, { limit: body.limit })) };
  }));

  app.post("/api/entities/resolve", handle(async (req) => {
    const { appId, manifest } = await ctx(req);
    const body = req.body as { type?: unknown; match?: Record<string, string>; sourceId?: string };
    if (!body.match || typeof body.match !== "object") throw new EntitiesError("match is required");
    const { normalizeKey, nameKey } = await import("./entitiesCore.js");
    const type = asType(body.type);
    const keys: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.match)) {
      const n = k === "name" ? nameKey(type, v) : normalizeKey(k, v);
      if (n) keys[k] = n;
    }
    return resolveKeys(await deps.sqlPort(appId, primarySource(manifest, body.sourceId)), type, keys);
  }));

  app.post("/api/entities/get", handle(async (req) => {
    const { appId, manifest } = await ctx(req);
    const body = req.body as { entityId?: string; table?: string; row?: string | number; type?: unknown; sourceId?: string };
    const db = await deps.sqlPort(appId, primarySource(manifest, body.sourceId));
    if (body.entityId) return { entity: await getEntity(db, body.entityId) };
    if (body.table && body.row !== undefined) {
      return { entity: await entityForRow(db, body.table, String(body.row), body.type ? asType(body.type) : undefined) };
    }
    throw new EntitiesError("Pass entityId, or table + row");
  }));

  app.post("/api/entities/observe", handle(async (req) => {
    const { appId, manifest } = await ctx(req);
    const body = req.body as { sourceId?: string; about?: unknown; text?: string; facts?: Record<string, unknown>; source?: { table?: string; row?: string } };
    const about = Array.isArray(body.about) ? body.about.map((a: { type?: unknown; entityId?: string; match?: Record<string, string> }) => ({ ...a, type: asType(a.type) })) : [];
    const db = await deps.sqlPort(appId, primarySource(manifest, body.sourceId));
    const graph = manifest.mode === "live" ? await deps.graphPort?.(appId, manifest) : undefined;
    return observe(db, manifest, { about, text: body.text, facts: body.facts, source: body.source }, graph);
  }));
}
