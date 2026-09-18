/**
 * Worker thread for executing better-sqlite3 queries off the main event loop.
 *
 * better-sqlite3 is synchronous — every .all() / .run() / .exec() call blocks
 * the thread it runs on.  By moving these calls into a dedicated worker thread
 * we keep the Gateway's main event loop free so that health-check pings, WebSocket
 * frames and other I/O always get serviced promptly.
 */

import { openDiagnosticDatabase } from "../services/databaseDiagnostics/sqlite.js";

import { parentPort } from "node:worker_threads";
import Database from "better-sqlite3";
import {
  resolveWorkerBusyTimeoutMs,
  type DbWorkerRequestType,
} from "../services/appRuntime/dbBusyRetry.js";

// ── Message protocol ──────────────────────────────────────────────────────

export interface DbWorkerWriteBatchStatement {
  sql: string;
  params?: unknown[];
}

export interface DbWorkerRequest {
  id: number;
  /** Shared with the retry policy so the two cannot list different types. */
  type: DbWorkerRequestType;
  dbPath: string;
  sql?: string;
  params?: unknown[];
  statements?: DbWorkerWriteBatchStatement[];
  readonly?: boolean;
  tableName?: string;
}

export interface DbWorkerResponse {
  id: number;
  success: boolean;
  data?: unknown;
  error?: string;
  /**
   * SQLite's own code, kept alongside the message. Only the message survives a
   * postMessage of an Error, and the pool classifies lock contention on this —
   * better-sqlite3 raises `SQLITE_BUSY`, which is the authoritative signal.
   */
  errorCode?: string;
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
function openDb(
  dbPath: string,
  readonly: boolean,
  busyTimeoutMs: number,
): Database.Database {
  const openOptions: Database.Options = {
    readonly,
    fileMustExist: true,
    timeout: busyTimeoutMs,
  };
  try {
    const db = openDiagnosticDatabase(Database, "workers/db-query-worker", dbPath, openOptions);
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    return db;
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";
    const recoverable =
      readonly && (code === "SQLITE_IOERR" || code === "SQLITE_CANTOPEN" || code === "SQLITE_READONLY");
    if (!recoverable) throw err;
    // Read-write open lets SQLite rebuild the -shm sidecar from the -wal.
    const db = openDiagnosticDatabase(Database, "workers/db-query-worker", dbPath, {
      readonly: false,
      fileMustExist: true,
      timeout: busyTimeoutMs,
    });
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    return db;
  }
}

function isReadonlyRequest(req: DbWorkerRequest): boolean {
  if (req.readonly != null) {
    return req.readonly;
  }
  return (
    req.type === "query" || req.type === "schema" || req.type === "table-exists"
  );
}

function handle(req: DbWorkerRequest): DbWorkerResponse {
  const db = openDb(
    req.dbPath,
    isReadonlyRequest(req),
    resolveWorkerBusyTimeoutMs(req.type),
  );

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

      case "write-batch": {
        if (!req.statements?.length) throw new Error("statements required");
        const results: Array<{ changes: number; lastInsertRowid: number }> = [];
        let statements = req.statements;
        const leadingPragma = statements[0]?.sql?.trim().toUpperCase() ?? "";
        if (
          leadingPragma === "PRAGMA FOREIGN_KEYS = OFF" ||
          leadingPragma === "PRAGMA FOREIGN_KEYS=OFF"
        ) {
          db.pragma("foreign_keys = OFF");
          statements = statements.slice(1);
        }
        if (statements.length === 0) {
          return { id: req.id, success: true, data: { results } };
        }
        const runBatch = db.transaction(
          (stmts: DbWorkerWriteBatchStatement[]) => {
            for (const stmt of stmts) {
              if (!stmt.sql) throw new Error("sql required");
              const result = db
                .prepare(stmt.sql)
                .run(...(stmt.params ?? [])) as {
                changes: number;
                lastInsertRowid: number | bigint;
              };
              results.push({
                changes: result.changes,
                lastInsertRowid:
                  typeof result.lastInsertRowid === "bigint"
                    ? Number(result.lastInsertRowid)
                    : result.lastInsertRowid,
              });
            }
          },
        );
        runBatch(statements);
        return { id: req.id, success: true, data: { results } };
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
        errorCode: (err as { code?: string }).code,
      } satisfies DbWorkerResponse);
    }
  });
}
