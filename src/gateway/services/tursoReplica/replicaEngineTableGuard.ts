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

import * as fs from "fs";
import Database from "better-sqlite3";

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
 * An empty array means the file is safe to open as far as this check can tell.
 */
export function inspectReplicaEngineTables(
  dbPath: string,
): ReplicaEngineTableDefect[] {
  if (!fs.existsSync(dbPath)) {
    return [];
  }
  try {
    const stats = fs.statSync(dbPath);
    if (stats.size === 0) {
      return [];
    }
  } catch {
    return [];
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    // Unreadable here says nothing about the engine's view; leave it alone.
    return [];
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
    return defects;
  } catch {
    return [];
  } finally {
    db.close();
  }
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

  const db = new Database(dbPath);
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
