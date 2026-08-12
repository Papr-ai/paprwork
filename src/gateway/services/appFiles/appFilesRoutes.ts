/**
 * /api/files/* — the mini-app facing surface for App Files.
 *
 * Mini-apps call these; they never talk to the memory server or GCS directly.
 * Registered from index.ts with the existing dbRouter and source resolver, so
 * file rows live in the same app database as everything else and sync the same
 * way.
 */

import type { Express } from "express";

import {
  addFile,
  commitBrowserUpload,
  createBrowserTicket,
  ensureSchema,
  listFiles,
  removeFile,
  resolveFileUrl,
  evictLocal,
  type FilesDb,
} from "./AppFilesService.js";
import { appUsage } from "./appFilesClient.js";
import { resolveMiniAppIdFromRequest } from "../../utils/inferMiniAppIdFromRequest.js";

/** Minimal shape of the pieces index.ts already has wired up. */
export interface AppFilesRouteDeps {
  resolveSource: (
    appId: string,
    sourceId: string | undefined,
    sql: string | undefined,
    operation: "read" | "write",
  ) => Promise<unknown>;
  dbQuery: (
    appId: string,
    source: unknown,
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows?: unknown[] }>;
  dbWrite: (
    appId: string,
    source: unknown,
    sql: string,
    params?: unknown[],
  ) => Promise<{ changes: number }>;
  dbExec?: (appId: string, source: unknown, sql: string) => Promise<unknown>;
}

/** Adapt the gateway's db plumbing to the small surface the service needs. */
async function dbFor(
  appId: string,
  sourceId: string | undefined,
  deps: AppFilesRouteDeps,
): Promise<FilesDb> {
  const readSource = await deps.resolveSource(appId, sourceId, undefined, "read");
  const writeSource = await deps.resolveSource(appId, sourceId, undefined, "write");
  return {
    async exec(sql: string) {
      // Schema creation goes through the write path; exec is optional in some
      // deployments, so fall back rather than hard-fail on bootstrap.
      if (deps.dbExec) {
        await deps.dbExec(appId, writeSource, sql);
        return;
      }
      for (const stmt of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
        await deps.dbWrite(appId, writeSource, stmt);
      }
    },
    async run(sql: string, params?: unknown[]) {
      return deps.dbWrite(appId, writeSource, sql, params);
    },
    async all<T>(sql: string, params?: unknown[]) {
      const result = await deps.dbQuery(appId, readSource, sql, params);
      return (result.rows ?? []) as T[];
    },
  };
}

function fail(res: Parameters<Parameters<Express["post"]>[1]>[1], err: unknown) {
  const e = err as Error & { status?: number };
  console.error("[Gateway] /api/files error:", e.message);
  res.status(e.status ?? 500).json({ error: e.message });
}

export function registerAppFilesRoutes(
  app: Express,
  deps: AppFilesRouteDeps,
): void {
  /**
   * Upload a file that already exists on local disk.
   *
   * Takes a path rather than a byte stream deliberately: multi-GB uploads
   * should not be buffered through an Express body, and the file is already
   * on this machine.
   */
  app.post("/api/files/upload", async (req, res) => {
    try {
      const { appId, sourceId, filePath, fileName, mime, scope, keepLocal } =
        req.body as {
          appId?: string;
          sourceId?: string;
          filePath?: string;
          fileName?: string;
          mime?: string;
          scope?: "app" | "user";
          keepLocal?: boolean;
        };
      if (!appId || !filePath) {
        res.status(400).json({ error: "appId and filePath are required" });
        return;
      }

      const db = await dbFor(appId, sourceId, deps);
      await ensureSchema(db);
      const result = await addFile(db, {
        appId,
        filePath,
        fileName,
        mime,
        scope,
        keepLocal: keepLocal !== false,
      });
      res.json(result);
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * Mint a ticket so the browser can PUT bytes straight to object storage.
   *
   * The bytes deliberately do not come through here. Relaying a 10 GB upload
   * would cost the gateway memory or disk proportional to the file and double
   * the bandwidth — the mistake this whole design exists to avoid.
   */
  app.post("/api/files/ticket", async (req, res) => {
    try {
      const { appId, sourceId, fileName, sizeBytes, mime, scope, fingerprint } =
        req.body as {
          appId?: string;
          sourceId?: string;
          fileName?: string;
          sizeBytes?: number;
          mime?: string | null;
          scope?: "app" | "user";
          fingerprint?: string;
        };

      const resolved = resolveMiniAppIdFromRequest(appId, req.headers);
      if (!resolved.appId) {
        res.status(resolved.status ?? 400).json({ error: resolved.error });
        return;
      }
      if (!fileName || typeof sizeBytes !== "number" || !fingerprint) {
        res
          .status(400)
          .json({ error: "fileName, sizeBytes and fingerprint are required" });
        return;
      }

      const db = await dbFor(resolved.appId, sourceId, deps);
      await ensureSchema(db);
      res.json(
        await createBrowserTicket(db, {
          appId: resolved.appId,
          fileName,
          sizeBytes,
          mime,
          scope,
          fingerprint,
        }),
      );
    } catch (err) {
      fail(res, err);
    }
  });

  /** Verify a browser upload once the bytes have landed in storage. */
  app.post("/api/files/commit", async (req, res) => {
    try {
      const { appId, sourceId, id, objectKey, sizeBytes } = req.body as {
        appId?: string;
        sourceId?: string;
        id?: string;
        objectKey?: string;
        sizeBytes?: number;
      };

      const resolved = resolveMiniAppIdFromRequest(appId, req.headers);
      if (!resolved.appId) {
        res.status(resolved.status ?? 400).json({ error: resolved.error });
        return;
      }
      if (!id || !objectKey || typeof sizeBytes !== "number") {
        res
          .status(400)
          .json({ error: "id, objectKey and sizeBytes are required" });
        return;
      }

      const db = await dbFor(resolved.appId, sourceId, deps);
      res.json(
        await commitBrowserUpload(db, {
          appId: resolved.appId,
          id,
          objectKey,
          sizeBytes,
        }),
      );
    } catch (err) {
      fail(res, err);
    }
  });

  /** Resolve a file to a readable URL — local path or short-lived signed URL. */
  app.post("/api/files/url", async (req, res) => {
    try {
      const { appId, sourceId, id } = req.body as {
        appId?: string;
        sourceId?: string;
        id?: string;
      };
      if (!id) {
        res.status(400).json({ error: "id is required" });
        return;
      }
      // appId is inferred from the requesting app when omitted, so mini-app
      // code never has to hardcode its own UUID.
      const resolved = resolveMiniAppIdFromRequest(appId, req.headers);
      if (!resolved.appId) {
        res.status(resolved.status ?? 400).json({ error: resolved.error });
        return;
      }
      const db = await dbFor(resolved.appId, sourceId, deps);
      res.json(await resolveFileUrl(db, id));
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/files", async (req, res) => {
    try {
      const appId = req.query.appId as string | undefined;
      const sourceId = req.query.sourceId as string | undefined;
      const resolved = resolveMiniAppIdFromRequest(appId, req.headers);
      if (!resolved.appId) {
        res.status(resolved.status ?? 400).json({ error: resolved.error });
        return;
      }
      const db = await dbFor(resolved.appId, sourceId, deps);
      await ensureSchema(db);
      res.json({ files: await listFiles(db, resolved.appId) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/files/delete", async (req, res) => {
    try {
      const { appId, sourceId, id } = req.body as {
        appId?: string;
        sourceId?: string;
        id?: string;
      };
      if (!id) {
        res.status(400).json({ error: "id is required" });
        return;
      }
      const resolved = resolveMiniAppIdFromRequest(appId, req.headers);
      if (!resolved.appId) {
        res.status(resolved.status ?? 400).json({ error: resolved.error });
        return;
      }
      const db = await dbFor(resolved.appId, sourceId, deps);
      res.json({ deleted: await removeFile(db, id) });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * Reclaim disk by dropping local copies. Only touches verified files, and
   * only when the caller explicitly asks — never automatic.
   */
  app.post("/api/files/evict", async (req, res) => {
    try {
      const { appId, sourceId, objectKey } = req.body as {
        appId?: string;
        sourceId?: string;
        objectKey?: string;
      };
      if (!appId || !objectKey) {
        res.status(400).json({ error: "appId and objectKey are required" });
        return;
      }
      const db = await dbFor(appId, sourceId, deps);
      res.json({ evicted: await evictLocal(db, objectKey) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/files/usage", async (req, res) => {
    try {
      const appId = req.query.appId as string | undefined;
      if (!appId) {
        res.status(400).json({ error: "appId is required" });
        return;
      }
      res.json(await appUsage(appId));
    } catch (err) {
      fail(res, err);
    }
  });
}
