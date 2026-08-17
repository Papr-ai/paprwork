/**
 * Worker thread for executing better-sqlite3 queries off the main event loop.
 *
 * better-sqlite3 is synchronous — every .all() / .run() / .exec() call blocks
 * the thread it runs on.  By moving these calls into a dedicated worker thread
 * we keep the Gateway's main event loop free so that health-check pings, WebSocket
 * frames and other I/O always get serviced promptly.
 */

import { parentPort } from "node:worker_threads";
import Database from "better-sqlite3";

// ── Message protocol ──────────────────────────────────────────────────────

export interface DbWorkerRequest {
  id: number;
  type: "query" | "write" | "schema" | "exec" | "table-exists";
  dbPath: string;
  sql?: string;
  params?: unknown[];
  readonly?: boolean;
  tableName?: string;
}

export interface DbWorkerResponse {
  id: number;
  success: boolean;
  data?: unknown;
  error?: string;
}

// ── Handler ───────────────────────────────────────────────────────────────

/**
 * Open a SQLite database, tolerating a missing/stale -shm sidecar.
 *
 * A WAL-mode database needs a writable -shm shared-memory file even for READS.
 * If -shm is deleted or unwritable (backup tooling copying data.db without its
 * sidecars, permissions, restore-in-place), a readonly open fails with
 * SQLITE_IOERR — surfaced to mini-apps as a bare "disk I/O error". The app then
 * renders an empty list, which looks like data loss but is purely an open failure.
 *
 * Fix: retry read-write once so SQLite can recreate -shm, then continue. We never
 * silently swallow real corruption — SQLITE_CORRUPT still propagates.
 */
function openDb(dbPath: string, readonly: boolean): Database.Database {
  try {
    return new Database(dbPath, { readonly, fileMustExist: true });
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";
    const recoverable =
      readonly && (code === "SQLITE_IOERR" || code === "SQLITE_CANTOPEN" || code === "SQLITE_READONLY");
    if (!recoverable) throw err;
    // Read-write open lets SQLite rebuild the -shm sidecar from the -wal.
    return new Database(dbPath, { readonly: false, fileMustExist: true });
  }
}

function handle(req: DbWorkerRequest): DbWorkerResponse {
  const db = openDb(req.dbPath, req.readonly ?? req.type !== "write");

  try {
    switch (req.type) {
      case "query": {
        if (!req.sql) throw new Error("sql required");
        const rows = db
          .prepare(req.sql)
          .all(...(req.params ?? [])) as Record<string, unknown>[];
        const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
        return { id: req.id, success: true, data: { rows, columns, count: rows.length } };
      }

      case "write": {
        if (!req.sql) throw new Error("sql required");
        const result = db
          .prepare(req.sql)
          .run(...(req.params ?? [])) as { changes: number; lastInsertRowid: number | bigint };
        const lastInsertRowid =
          typeof result.lastInsertRowid === "bigint"
            ? Number(result.lastInsertRowid)
            : result.lastInsertRowid;
        return { id: req.id, success: true, data: { changes: result.changes, lastInsertRowid } };
      }

      case "exec": {
        if (!req.sql) throw new Error("sql required");
        db.exec(req.sql);
        return { id: req.id, success: true, data: { ok: true } };
      }

      case "schema": {
        const tables = (
          db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .all() as { name: string }[]
        ).map((row) => {
          const cols = db
            .prepare(`PRAGMA table_info(${JSON.stringify(row.name)})`)
            .all() as { cid: number; name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[];
          return {
            table: row.name,
            columns: cols.map((c) => ({ name: c.name, type: c.type, pk: c.pk === 1 })),
          };
        });
        return { id: req.id, success: true, data: { tables } };
      }

      case "table-exists": {
        if (!req.tableName) throw new Error("tableName required");
        const row = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1")
          .get(req.tableName);
        return { id: req.id, success: true, data: { exists: row !== undefined } };
      }

      default:
        return { id: req.id, success: false, error: "Unknown request type" };
    }
  } finally {
    db.close();
  }
}

// ── Listen for requests from main thread ──────────────────────────────────

if (parentPort) {
  parentPort.on("message", (req: DbWorkerRequest) => {
    try {
      parentPort!.postMessage(handle(req));
    } catch (err) {
      parentPort!.postMessage({
        id: req.id,
        success: false,
        error: (err as Error).message,
      } satisfies DbWorkerResponse);
    }
  });
}
