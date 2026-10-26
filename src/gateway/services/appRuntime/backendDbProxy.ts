/**
 * Loopback DB proxy for backend Python subprocesses.
 * Routes papr_db.query/write through the same adapters as /api/db/* (validation, local-first writes).
 */

import { randomBytes } from "node:crypto";
import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import type { AppDataSource } from "../appDataSources.js";
import type { AppRuntimeRouteAuth } from "./types.js";
import { assertReadOnlySql, assertWriteSql } from "./sqlValidation.js";
import { bindCallerId } from "./actionAcl.js";

export interface BackendDbProxySession {
  appId: string;
  sourceId?: string;
  /** Job-only sessions resolve registry DBs without an app data-sources.json entry. */
  registryDbId?: string;
  /**
   * Job sessions: every registry database the job may write (its writeDbIds).
   * A request may name one by dbId, registry label, or the alias any linked
   * app gives it. See resolveJobSessionSource.
   */
  allowedDbIds?: string[];
  expiresAt: number;
  cloud?: {
    runtimeAuth: AppRuntimeRouteAuth;
    orgId: string;
    namespaceId: string;
    userId: string;
    callerUserId?: string;
    canRead: boolean;
    canWrite: boolean;
  };
}

export interface DesktopBackendDbProxyDeps {
  resolveSource: (
    appId: string,
    sourceId: string | undefined,
    sql: string,
    operation: "read" | "write",
  ) => Promise<AppDataSource>;
  resolveRegistrySource?: (
    dbId: string,
    sourceId: string | undefined,
  ) => Promise<AppDataSource>;
  /** Registry label for a dbId (null when missing/inactive). */
  registryLabel?: (dbId: string) => Promise<string | null>;
  /** Aliases an app's data-sources.json gives registry databases. */
  appDbAliases?: (appId: string) => Promise<Array<{ dbId: string; alias: string }>>;
  query: (
    appId: string,
    source: AppDataSource,
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[]; count: number }>;
  write: (
    appId: string,
    source: AppDataSource,
    sql: string,
    params?: unknown[],
  ) => Promise<{ changes: number; lastInsertRowid: number }>;
}

export interface CloudBackendDbProxyDeps {
  query: (
    session: BackendDbProxySession,
    sql: string,
    params: unknown[] | undefined,
    sourceId: string | undefined,
  ) => Promise<{ rows: Record<string, unknown>[]; count: number }>;
  write: (
    session: BackendDbProxySession,
    sql: string,
    params: unknown[] | undefined,
    sourceId: string | undefined,
  ) => Promise<{ changes: number; lastInsertRowid: number }>;
}

const sessions = new Map<string, BackendDbProxySession>();

const DEFAULT_TTL_MS = 600_000;

function pruneExpiredSessions(): void {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

export function mintBackendDbProxyEnv(input: {
  appId: string;
  sourceId?: string;
  registryDbId?: string;
  allowedDbIds?: readonly string[];
  proxyBaseUrl: string;
  cloud?: BackendDbProxySession["cloud"];
  ttlMs?: number;
}): Record<string, string> {
  pruneExpiredSessions();
  const token = randomBytes(24).toString("hex");
  sessions.set(token, {
    appId: input.appId,
    sourceId: input.sourceId?.trim() || undefined,
    registryDbId: input.registryDbId?.trim() || undefined,
    allowedDbIds: input.allowedDbIds?.length
      ? [...new Set(input.allowedDbIds.map((id) => id.trim()).filter(Boolean))]
      : undefined,
    expiresAt: Date.now() + (input.ttlMs ?? DEFAULT_TTL_MS),
    cloud: input.cloud,
  });
  const base = input.proxyBaseUrl.replace(/\/$/, "");
  return {
    PAPR_DB_MODE: "proxy",
    PAPR_DB_PROXY_URL: `${base}/internal/backend-db`,
    PAPR_DB_PROXY_TOKEN: token,
    ...(input.sourceId?.trim() ? { PAPR_ACTIVE_SOURCE_ID: input.sourceId.trim() } : {}),
  };
}

export function revokeBackendDbProxyToken(token: string | undefined): void {
  if (!token?.trim()) {
    return;
  }
  sessions.delete(token.trim());
}

function readProxyToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim();
  }
  const body = req.body as { token?: string } | undefined;
  if (body?.token?.trim()) {
    return body.token.trim();
  }
  return null;
}

function requireSession(req: Request, res: Response): BackendDbProxySession | null {
  const token = readProxyToken(req);
  if (!token) {
    res.status(401).json({ error: "Backend DB proxy token required" });
    return null;
  }
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(token ?? "");
    res.status(401).json({ error: "Backend DB proxy token expired or invalid" });
    return null;
  }
  return session;
}

function httpError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

/**
 * Which allowed database does `name` refer to? Matches the dbId, the registry
 * label, or any alias a linked app gives that database. Pure — exported for tests.
 * Returns [] when nothing matches; more than one dbId means the name is ambiguous.
 */
export function matchAllowedDbIds(
  name: string,
  allowed: ReadonlyArray<{ dbId: string; label: string | null; appAliases: readonly string[] }>,
): string[] {
  const wanted = name.trim();
  const hits = allowed.filter(
    (db) =>
      db.dbId === wanted ||
      (db.label?.trim() ?? "") === wanted ||
      db.appAliases.some((alias) => alias.trim() === wanted),
  );
  return [...new Set(hits.map((db) => db.dbId))];
}

/**
 * Job proxy sessions: a job may name any database it is allowed to write by
 * dbId, registry label, or its linked app's alias. Names that match none of
 * them fall back to the app's own data sources (unchanged behaviour), so this
 * never grants access a job did not already have.
 */
async function resolveJobSessionSource(
  deps: DesktopBackendDbProxyDeps,
  session: BackendDbProxySession,
  sourceId: string | undefined,
  sql: string,
  operation: "read" | "write",
): Promise<AppDataSource> {
  const allowedIds = session.allowedDbIds ?? [];
  const resolveRegistry = deps.resolveRegistrySource!;
  const requested = sourceId?.trim();
  if (!requested) {
    if (allowedIds.length === 1) return resolveRegistry(allowedIds[0], undefined);
    if (session.sourceId) return resolveJobSessionSource(deps, session, session.sourceId, sql, operation);
    throw httpError(
      `This job can write ${allowedIds.length} databases; pass sourceId (dbId, name, or app alias).`,
      400,
    );
  }

  const linkedApp = session.appId && session.appId !== "__standalone__" ? session.appId : null;
  const appAliases = linkedApp && deps.appDbAliases ? await deps.appDbAliases(linkedApp).catch(() => []) : [];
  const allowed = await Promise.all(
    allowedIds.map(async (dbId) => ({
      dbId,
      label: deps.registryLabel ? await deps.registryLabel(dbId) : null,
      appAliases: appAliases.filter((a) => a.dbId === dbId).map((a) => a.alias),
    })),
  );
  const matches = matchAllowedDbIds(requested, allowed);
  if (matches.length === 1) return resolveRegistry(matches[0], undefined);
  if (matches.length > 1) {
    throw httpError(
      `sourceId "${requested}" matches more than one database this job can write (${matches.join(", ")}). Use the dbId.`,
      409,
    );
  }
  if (linkedApp) {
    return deps.resolveSource(linkedApp, requested, sql, operation);
  }
  throw httpError(
    `Unknown sourceId "${requested}". This job can use: ${allowed
      .map((db) => [db.dbId, db.label, ...db.appAliases].filter(Boolean).join(" / "))
      .join("; ")}.`,
    400,
  );
}

export async function resolveDesktopProxySource(
  deps: DesktopBackendDbProxyDeps,
  session: BackendDbProxySession,
  sourceId: string | undefined,
  sql: string,
  operation: "read" | "write",
): Promise<AppDataSource> {
  const resolvedSourceId = sourceId ?? session.sourceId;
  if (session.allowedDbIds?.length && deps.resolveRegistrySource) {
    return resolveJobSessionSource(deps, session, sourceId, sql, operation);
  }
  if (session.registryDbId && deps.resolveRegistrySource) {
    return deps.resolveRegistrySource(session.registryDbId, resolvedSourceId);
  }
  return deps.resolveSource(session.appId, resolvedSourceId, sql, operation);
}

export function createDesktopBackendDbProxyRouter(
  deps: DesktopBackendDbProxyDeps,
): Router {
  const router = createRouter();

  router.post("/query", async (req, res) => {
    try {
      const session = requireSession(req, res);
      if (!session) return;

      const { sql, params, sourceId } = req.body as {
        sql?: string;
        params?: unknown[];
        sourceId?: string;
      };
      if (!sql?.trim()) {
        res.status(400).json({ error: "sql is required" });
        return;
      }

      assertReadOnlySql(sql);
      const source = await resolveDesktopProxySource(
        deps,
        session,
        sourceId,
        sql,
        "read",
      );
      const result = await deps.query(session.appId, source, sql, params);
      res.json({ rows: result.rows, count: result.count });
    } catch (err) {
      const e = err as Error & { status?: number };
      const { httpStatusForDbRouteError } = await import(
        "../tursoReplica/replicaSchemaQueryErrorMessage.js"
      );
      res.status(httpStatusForDbRouteError(e)).json({ error: e.message });
    }
  });

  router.post("/write", async (req, res) => {
    try {
      const session = requireSession(req, res);
      if (!session) return;

      const { sql, params, sourceId } = req.body as {
        sql?: string;
        params?: unknown[];
        sourceId?: string;
      };
      if (!sql?.trim()) {
        res.status(400).json({ error: "sql is required" });
        return;
      }

      assertWriteSql(sql);
      const { assertReplaySafeRowSql } = await import(
        "../syncV3/replaySafeSql.js"
      );
      assertReplaySafeRowSql(sql);

      const source = await resolveDesktopProxySource(
        deps,
        session,
        sourceId,
        sql,
        "write",
      );
      const result = await deps.write(session.appId, source, sql, params);
      res.json({
        changes: result.changes,
        lastInsertRowid: result.lastInsertRowid,
      });
    } catch (err) {
      const e = err as Error & { status?: number };
      const { httpStatusForDbRouteError } = await import(
        "../tursoReplica/replicaSchemaQueryErrorMessage.js"
      );
      res.status(httpStatusForDbRouteError(e)).json({ error: e.message });
    }
  });

  return router;
}

export function createCloudBackendDbProxyRouter(
  deps: CloudBackendDbProxyDeps,
): Router {
  const router = createRouter();

  router.post("/query", async (req, res) => {
    try {
      const session = requireSession(req, res);
      if (!session?.cloud) {
        res.status(401).json({ error: "Invalid cloud backend DB proxy session" });
        return;
      }

      const { sql, params, sourceId } = req.body as {
        sql?: string;
        params?: unknown[];
        sourceId?: string;
      };
      if (!sql?.trim()) {
        res.status(400).json({ error: "sql is required" });
        return;
      }

      assertReadOnlySql(sql);
      const resolvedSourceId = sourceId?.trim() || session.sourceId;
      // :caller_id comes from the verified sign-in, never from the handler.
      const bound = bindCallerId(sql, params, session.cloud.callerUserId) as unknown[] | undefined;
      const result = await deps.query(session, sql, bound, resolvedSourceId);
      res.json({ rows: result.rows, count: result.count });
    } catch (err) {
      const e = err as Error & { status?: number };
      res.status(e.status ?? 500).json({ error: e.message });
    }
  });

  router.post("/write", async (req, res) => {
    try {
      const session = requireSession(req, res);
      if (!session?.cloud) {
        res.status(401).json({ error: "Invalid cloud backend DB proxy session" });
        return;
      }

      const { sql, params, sourceId } = req.body as {
        sql?: string;
        params?: unknown[];
        sourceId?: string;
      };
      if (!sql?.trim()) {
        res.status(400).json({ error: "sql is required" });
        return;
      }

      assertWriteSql(sql);
      const resolvedSourceId = sourceId?.trim() || session.sourceId;
      const bound = bindCallerId(sql, params, session.cloud.callerUserId) as unknown[] | undefined;
      const result = await deps.write(session, sql, bound, resolvedSourceId);
      res.json({
        changes: result.changes,
        lastInsertRowid: result.lastInsertRowid,
      });
    } catch (err) {
      const e = err as Error & { status?: number };
      res.status(e.status ?? 500).json({ error: e.message });
    }
  });

  return router;
}
