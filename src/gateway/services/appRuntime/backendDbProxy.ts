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

export interface BackendDbProxySession {
  appId: string;
  sourceId?: string;
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
    params?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[]; count: number }>;
  write: (
    session: BackendDbProxySession,
    sql: string,
    params?: unknown[],
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
  proxyBaseUrl: string;
  cloud?: BackendDbProxySession["cloud"];
  ttlMs?: number;
}): Record<string, string> {
  pruneExpiredSessions();
  const token = randomBytes(24).toString("hex");
  sessions.set(token, {
    appId: input.appId,
    sourceId: input.sourceId?.trim() || undefined,
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
      const source = await deps.resolveSource(
        session.appId,
        sourceId ?? session.sourceId,
        sql,
        "read",
      );
      const result = await deps.query(session.appId, source, sql, params);
      res.json({ rows: result.rows, count: result.count });
    } catch (err) {
      const e = err as Error & { status?: number };
      res.status(e.status ?? 500).json({ error: e.message });
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

      const source = await deps.resolveSource(
        session.appId,
        sourceId ?? session.sourceId,
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
      res.status(e.status ?? 500).json({ error: e.message });
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

      const { sql, params } = req.body as { sql?: string; params?: unknown[] };
      if (!sql?.trim()) {
        res.status(400).json({ error: "sql is required" });
        return;
      }

      assertReadOnlySql(sql);
      const result = await deps.query(session, sql, params);
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

      const { sql, params } = req.body as { sql?: string; params?: unknown[] };
      if (!sql?.trim()) {
        res.status(400).json({ error: "sql is required" });
        return;
      }

      assertWriteSql(sql);
      const result = await deps.write(session, sql, params);
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
