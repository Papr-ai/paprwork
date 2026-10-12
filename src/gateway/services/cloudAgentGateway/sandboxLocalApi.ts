/**
 * Cloud agent sandbox: serve the desktop's loopback app API on 127.0.0.1:18789.
 *
 * Agent jobs (and app backend handlers) call `curl localhost:18789/api/app/backend/<action>`
 * and `/api/db/*` on desktop. The sandbox has no desktop gateway, so those calls
 * failed and prompts needed a cloud-only fallback. This exposes the same routes,
 * backed by the same services:
 *   - /api/app/backend/:action → AppBackendService (handler runs with the run's vault keys)
 *   - /internal/backend-db/*   → papr_db proxy for those handlers
 *   - /api/db/query|write      → the app's linked sources
 * Reads/writes resolve through the registry, which seedCloudDatabaseRegistry marks
 * cloud-direct, so everything goes straight to the cloud primary.
 *
 * Bound to loopback only; Cloud Run serves one run per instance (concurrency=1).
 */

import fs from "fs/promises";
import path from "path";
import express from "express";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import type { AppDataSource } from "../appDataSources.js";
import { parseDataSourcesFile, resolveAppDataSource } from "../appDataSources.js";
import {
  cloudDirectQuery,
  cloudDirectWrite,
  isCloudDirectSource,
} from "../cloudDirect/cloudDirectDb.js";
import { createDesktopBackendDbProxyRouter } from "../appRuntime/backendDbProxy.js";
import { assertReadOnlySql, assertWriteSql } from "../appRuntime/sqlValidation.js";
import { httpStatusForDbRouteError } from "../tursoReplica/replicaSchemaQueryErrorMessage.js";

export const SANDBOX_LOCAL_API_PORT = 18789;

async function resolveSource(
  appId: string,
  sourceId: string | undefined,
  operation: "read" | "write",
): Promise<AppDataSource> {
  const file = path.join(getPaprRoot(), "apps", appId, "data-sources.json");
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    throw Object.assign(new Error(`No data sources for app ${appId} in this run`), { status: 404 });
  }
  return resolveAppDataSource(parseDataSourcesFile(raw), { sourceId, operation });
}

function requireCloudDirect(source: AppDataSource): void {
  if (!isCloudDirectSource(source)) {
    throw Object.assign(
      new Error(`Database ${source.dbId ?? source.alias} is not available in this cloud run`),
      { status: 404 },
    );
  }
}

async function query(_appId: string, source: AppDataSource, sql: string, params?: unknown[]) {
  requireCloudDirect(source);
  const r = await cloudDirectQuery(source, sql, params);
  return { rows: r.rows, count: r.count };
}

async function write(_appId: string, source: AppDataSource, sql: string, params?: unknown[]) {
  requireCloudDirect(source);
  return cloudDirectWrite(source, sql, params);
}

function appIdFrom(body: { appId?: string }): string {
  const appId = body.appId?.trim() || process.env.APP_ID?.trim();
  if (!appId) throw Object.assign(new Error("appId is required"), { status: 400 });
  return appId;
}

function sendError(res: express.Response, err: unknown): void {
  const e = err as Error & { status?: number };
  res.status(e.status ?? httpStatusForDbRouteError(e)).json({ error: e.message });
}

export function createSandboxLocalApi(): express.Express {
  const app = express();
  app.use(express.json({ limit: "5mb" }));

  app.use(
    "/internal/backend-db",
    createDesktopBackendDbProxyRouter({
      resolveSource: (appId, sourceId, _sql, operation) => resolveSource(appId, sourceId, operation),
      query,
      write,
    }),
  );

  app.post("/api/db/query", async (req, res) => {
    try {
      const { sql, params, sourceId } = req.body as { sql?: string; params?: unknown[]; sourceId?: string };
      if (!sql) return void res.status(400).json({ error: "sql is required" });
      assertReadOnlySql(sql);
      const appId = appIdFrom(req.body);
      res.json(await query(appId, await resolveSource(appId, sourceId, "read"), sql, params));
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post("/api/db/write", async (req, res) => {
    try {
      const { sql, params, sourceId } = req.body as { sql?: string; params?: unknown[]; sourceId?: string };
      if (!sql) return void res.status(400).json({ error: "sql is required" });
      assertWriteSql(sql);
      const appId = appIdFrom(req.body);
      res.json(await write(appId, await resolveSource(appId, sourceId, "write"), sql, params));
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post("/api/app/backend/:action", async (req, res) => {
    try {
      const body = req.body as { appId?: string; params?: Record<string, string> };
      const appId = appIdFrom(body);
      const action = req.params.action?.trim();
      const { parseAppBackendManifest, backendManifestRelativePath } = await import(
        "../appRuntime/appBackendManifest.js"
      );
      const manifest = parseAppBackendManifest(
        JSON.parse(
          await fs.readFile(path.join(getPaprRoot(), backendManifestRelativePath(appId)), "utf8"),
        ),
      );
      const spec = manifest.actions[action];
      if (!spec) return void res.status(404).json({ error: `Unknown backend action: ${action}` });

      // Vault keys for this run are already in process.env (applyVaultKeys).
      const vaultEnv: Record<string, string> = {};
      for (const key of spec.keys ?? []) {
        const value = process.env[key];
        if (value) vaultEnv[key] = value;
      }
      const { AppBackendService } = await import("../appRuntime/AppBackendService.js");
      const { getPaprCallerIdentity } = await import("../../utils/paprUserId.js");
      const { sanitizeError } = await import("../../../core/tools/security.js");
      const callerIdentity = getPaprCallerIdentity();
      const result = await new AppBackendService().runAction({
        appId,
        action,
        params: body.params,
        vaultEnv,
        callerIdentity,
        loggedIn: Boolean(callerIdentity.userId?.trim()),
      });
      const secrets = Object.values(vaultEnv);
      res.json({
        ...result,
        stdout: sanitizeError(result.stdout, secrets),
        stderr: sanitizeError(result.stderr, secrets),
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  return app;
}

export function startSandboxLocalApi(): void {
  createSandboxLocalApi()
    .listen(SANDBOX_LOCAL_API_PORT, "127.0.0.1", () => {
      console.log(`[CloudAgentGateway] Sandbox local API on 127.0.0.1:${SANDBOX_LOCAL_API_PORT}`);
    })
    .on("error", (err) => {
      console.error("[CloudAgentGateway] Sandbox local API failed to start:", err);
    });
}
