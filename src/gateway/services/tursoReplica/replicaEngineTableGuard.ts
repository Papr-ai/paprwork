/**
 * Precondition check for the sync engine's private tables.
 *
 * Sibling to `tursoReplicaSidecarWedge.ts`, which guards a different panic. That one
 * covers `WalFile::find_frame` (a watermark naming a WAL frame that is not there). This
 * one covers `BTreeCursor::indexbtree_seek_internal`, reached on connect via
 * `op_init_cdc_version` -> `op_no_conflict`: the engine seeks a table's unique index to
 * decide whether a row already exists, and on a table that has no unique index the seek
 * `panic!`s and aborts the process.
 *
 * Like the sidecar check this is a precondition, not error handling — once connect runs
 * it is already too late to catch anything.
 *
 * Deliberately narrow, for the same reason the sidecar check is: repair throws away the
 * engine's bookkeeping, so a false positive costs real work. Only tables whose canonical
 * shape declares a non-INTEGER PRIMARY KEY are checked. `turso_cdc` is intentionally
 * absent — its key is `change_id INTEGER PRIMARY KEY AUTOINCREMENT`, which is the rowid,
 * so SQLite creates no separate index and "no index" is its healthy resting state.
 */

import { openDiagnosticDatabase } from "../databaseDiagnostics/sqlite.js";

import * as fs from "fs";
import Database from "better-sqlite3";

/**
 * Fail fast when the sync worker already holds this replica file.
 * better-sqlite3's default busy timeout is 5000ms of *synchronous* main-thread sleep,
 * which matches ~5s `[GatewayEventLoop]` spikes and inflates `openSpecMs` on every read.
 * @see tursoSyncState.ts LEGACY_PROBE_BUSY_TIMEOUT_MS
 */
export const REPLICA_ENGINE_INSPECT_BUSY_TIMEOUT_MS = 100;

/**
 * Engine tables that must carry a unique index when present.
 *
 * Verified against healthy replicas, which show
 * `sqlite_autoindex_turso_sync_last_change_id_1` and
 * `sqlite_autoindex_turso_cdc_version_1` from their TEXT primary keys.
 */
const TABLES_REQUIRING_UNIQUE_INDEX = [
  "turso_sync_last_change_id",
  "turso_cdc_version",
] as const;

export interface ReplicaEngineTableDefect {
  table: string;
  /** The engine will seek a unique index this table does not have. */
  reason: "missing_unique_index";
}

/**
 * The outcome of an inspection, with "found nothing" kept apart from "could not look".
 *
 * These two are not the same claim, and collapsing them into an empty array is what let
 * Issue 117 and Issue 118 each run their course: a file too contended or too damaged to
 * open reported zero defects, and every caller read that as a clean bill of health. A
 * readonly open can fail for reasons that have nothing to do with the tables — a `-shm`
 * needing recovery is one, and recovery is a write — so the failure is both plausible
 * and invisible.
 *
 * Callers still decide for themselves. The pre-open guard proceeds on `unreadable`,
 * because blocking every open on a contended probe would be worse than the panic it
 * guards; the crash chooser does not, because after an abort the same silence is the
 * difference between repairing a curable defect and parking a database for good.
 */
export type ReplicaEngineTableInspection =
  | { status: "inspected"; defects: readonly ReplicaEngineTableDefect[] }
  | { status: "unreadable"; reason: string };

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1",
    )
    .get(table);
  return row !== undefined;
}

function hasUniqueIndex(db: Database.Database, table: string): boolean {
  // index_list reports autoindexes as well as explicit ones, with a `unique` flag.
  const rows = db
    .prepare(`PRAGMA index_list(${quoteIdent(table)})`)
    .all() as Array<{ unique?: number }>;
  return rows.some((row) => Number(row.unique ?? 0) === 1);
}

/**
 * Engine tables present in `dbPath` that would make the engine panic on connect.
 *
 * An absent or empty file reports `inspected` with no defects rather than `unreadable`:
 * there is genuinely nothing there to be malformed, and the engine creates these tables
 * itself on connect. Only a file we tried and failed to read reports `unreadable`.
 */
export function inspectReplicaEngineTablesDetailed(
  dbPath: string,
): ReplicaEngineTableInspection {
  if (!fs.existsSync(dbPath)) {
    return { status: "inspected", defects: [] };
  }
  try {
    const stats = fs.statSync(dbPath);
    if (stats.size === 0) {
      return { status: "inspected", defects: [] };
    }
  } catch (error) {
    return { status: "unreadable", reason: `stat failed: ${(error as Error).message}` };
  }

  let db: Database.Database;
  try {
    db = openDiagnosticDatabase(Database, "services/tursoReplica/replicaEngineTableGuard", dbPath, {
      readonly: true,
      fileMustExist: true,
      timeout: REPLICA_ENGINE_INSPECT_BUSY_TIMEOUT_MS,
    });
  } catch (error) {
    // Contended, or damaged past a readonly open. Either way this is not a clean result,
    // and the caller has to be able to tell the difference — see the type's own note.
    return { status: "unreadable", reason: `open failed: ${(error as Error).message}` };
  }

  try {
    const defects: ReplicaEngineTableDefect[] = [];
    for (const table of TABLES_REQUIRING_UNIQUE_INDEX) {
      if (!tableExists(db, table)) {
        // Absent is fine — the engine creates these itself on connect.
        continue;
      }
      if (!hasUniqueIndex(db, table)) {
        defects.push({ table, reason: "missing_unique_index" });
      }
    }
    return { status: "inspected", defects };
  } catch (error) {
    return { status: "unreadable", reason: `read failed: ${(error as Error).message}` };
  } finally {
    db.close();
  }
}

/**
 * Defects visible in `dbPath`, with an unreadable file reported as none.
 *
 * For the pre-open guard, where "could not look" and "nothing to see" genuinely warrant
 * the same action: proceed, and let the worker's own validation and the crash policy
 * catch what this could not. Callers that must distinguish the two — anything deciding
 * whether a database is recoverable — take {@link inspectReplicaEngineTablesDetailed}.
 */
export function inspectReplicaEngineTables(
  dbPath: string,
): ReplicaEngineTableDefect[] {
  const inspection = inspectReplicaEngineTablesDetailed(dbPath);
  if (inspection.status === "unreadable") {
    // Not fatal here, but never silent: an inspection that cannot run looks exactly like
    // a healthy database, and that resemblance is what hid this defect through two fixes.
    console.warn(
      `[ReplicaEngineTableGuard] Could not inspect ${dbPath} — ${inspection.reason}`,
    );
    return [];
  }
  return [...inspection.defects];
}

/** One-line diagnostic for logs — names the tables and why they were dropped. */
export function describeReplicaEngineTableDefects(
  defects: readonly ReplicaEngineTableDefect[],
): string {
  return defects
    .map((defect) => `${defect.table} (${defect.reason})`)
    .join(", ");
}

/**
 * Drop defective engine tables so the engine rebuilds them correctly on next connect.
 *
 * Dropping rather than rewriting in place: these tables hold the engine's own sync
 * bookkeeping, the engine already creates them when absent (that is what
 * `init_cdc_version` does), and a table whose declared shape is wrong has contents of
 * questionable value anyway. The cost is re-deriving a sync cursor — some redundant
 * pull work — against a process abort on every connect.
 *
 * App tables are never touched. Returns the tables dropped.
 */
export function repairReplicaEngineTables(dbPath: string): string[] {
  const defects = inspectReplicaEngineTables(dbPath);
  if (defects.length === 0) {
    return [];
  }

  let db: Database.Database;
  try {
    db = openDiagnosticDatabase(Database, "services/tursoReplica/replicaEngineTableGuard", dbPath, {
      timeout: REPLICA_ENGINE_INSPECT_BUSY_TIMEOUT_MS,
    });
  } catch {
    return [];
  }
  try {
    const dropped: string[] = [];
    for (const defect of defects) {
      db.exec(`DROP TABLE IF EXISTS ${quoteIdent(defect.table)}`);
      dropped.push(defect.table);
    }
    return dropped;
  } finally {
    db.close();
  }
}
