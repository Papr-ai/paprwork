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

import * as fs from "fs";
import Database from "better-sqlite3";
import { listUserTables } from "./tursoReplicaBootstrapMarker.js";

export interface BootstrapReplayResult {
  tablesReplayed: number;
  rowsReplayed: number;
  skipped: string[];
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
): BootstrapReplayResult {
  const result: BootstrapReplayResult = {
    tablesReplayed: 0,
    rowsReplayed: 0,
    skipped: [],
  };
  if (!fs.existsSync(snapshotPath) || !fs.existsSync(dbPath)) {
    return result;
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath);
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
