/**
 * Replay rows preserved before a destructive sidecar repair.
 *
 * Repair deletes the sidecars, which is also where @tursodatabase/sync tracks *which* local
 * rows have not yet been pushed. The rows themselves survive in `data.db`, but the "these are
 * new, send them" label does not — so after a re-bootstrap the engine has no reason to push
 * them and they are silently orphaned.
 *
 * We deliberately do not try to reconstruct that label (the legacy `turso_cdc` path is
 * unreliable — see replicaPendingPush.ts, which already falls back to timestamps). Instead we
 * replay every preserved row as `INSERT OR REPLACE`:
 * - rows that came from Turso overwrite themselves — a no-op
 * - rows that only ever existed locally are re-inserted, become normal pending changes, and
 *   push on the next sync
 *
 * Over-preserving is safe; under-preserving loses user data. This errs to the safe side.
 */

import { openDiagnosticDatabase } from "../databaseDiagnostics/sqlite.js";

import * as fs from "fs";
import Database from "better-sqlite3";
import { listUserTables } from "./tursoReplicaBootstrapMarker.js";
import { getTursoReplicaSyncWorkerClient } from "./TursoReplicaSyncWorkerClient.js";

export interface BootstrapReplayResult {
  tablesReplayed: number;
  rowsReplayed: number;
  skipped: string[];
}

/**
 * Refuses a replay the sync engine would not survive.
 *
 * A bulk write beneath the worker's cached root pages reallocates pages under pointers it
 * still believes in; the engine then aborts the *process* from `btree.rs`, that abort resets
 * the sidecars, the reset re-bootstraps, and the bootstrap replays again — the corruption
 * renews itself. A native abort cannot be caught, so the only defence is a precondition.
 *
 * Throwing rather than returning empty is deliberate. The caller treats a throw as a failed
 * bootstrap attempt and leaves the marker and the snapshot in place, so the rows are replayed
 * on the next attempt; returning quietly would let the marker clear with local-only rows still
 * unreplayed, which is the under-preserving this module exists to avoid.
 */
export class ReplicaWorkerOwnsPathError extends Error {
  constructor(dbPath: string) {
    super(
      `Refusing to replay into ${dbPath}: the Turso sync worker still holds it. ` +
        "Close the worker handle first (TursoReplicaService.close) — a second SQLite " +
        "engine writing beneath its cached pages aborts the process.",
    );
    this.name = "ReplicaWorkerOwnsPathError";
  }
}

/**
 * Apply snapshot rows into a freshly bootstrapped replica.
 *
 * Tables absent from the bootstrapped schema are skipped rather than created — the cloud
 * schema is authoritative after a bootstrap, and resurrecting a dropped table would fight
 * the migration ledger.
 */
export function replayBootstrapSnapshot(
  dbPath: string,
  snapshotPath: string,
  ownsPath: (path: string) => boolean = (path) =>
    getTursoReplicaSyncWorkerClient().ownsPath(path),
): BootstrapReplayResult {
  const result: BootstrapReplayResult = {
    tablesReplayed: 0,
    rowsReplayed: 0,
    skipped: [],
  };
  // Checked before the existence tests: ownership is the fatal condition, and an early
  // return on a missing file would skip it.
  if (ownsPath(dbPath)) {
    throw new ReplicaWorkerOwnsPathError(dbPath);
  }
  if (!fs.existsSync(snapshotPath) || !fs.existsSync(dbPath)) {
    return result;
  }

  let db: Database.Database | null = null;
  try {
    db = openDiagnosticDatabase(Database, "services/tursoReplica/tursoReplicaBootstrapReplay", dbPath);
    db.prepare("ATTACH DATABASE ? AS papr_snapshot").run(snapshotPath);

    const liveTables = new Set(listUserTables(db));
    const snapshotTables = (
      db
        .prepare(
          "SELECT name FROM papr_snapshot.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);

    for (const table of snapshotTables) {
      if (!liveTables.has(table)) {
        result.skipped.push(table);
        continue;
      }
      // Column intersection: a migration may have added or dropped columns since the snapshot.
      const liveCols = new Set(
        (
          db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>
        ).map((c) => c.name),
      );
      const snapCols = (
        db
          .prepare(`PRAGMA papr_snapshot.table_info("${table}")`)
          .all() as Array<{ name: string }>
      )
        .map((c) => c.name)
        .filter((c) => liveCols.has(c));
      if (snapCols.length === 0) {
        result.skipped.push(table);
        continue;
      }
      const colList = snapCols.map((c) => `"${c}"`).join(", ");
      const info = db
        .prepare(
          `INSERT OR REPLACE INTO "${table}" (${colList}) SELECT ${colList} FROM papr_snapshot."${table}"`,
        )
        .run();
      result.tablesReplayed += 1;
      result.rowsReplayed += info.changes;
    }
    return result;
  } catch (error) {
    console.warn(
      `[TursoReplicaBootstrap] Replay failed for ${dbPath}: ${(error as Error).message}`,
    );
    return result;
  } finally {
    try {
      db?.prepare("DETACH DATABASE papr_snapshot").run();
    } catch {
      /* never attached */
    }
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}
