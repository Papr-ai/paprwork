/**
 * Plan A bootstrap-pending marker.
 *
 * Sidecar repair deliberately keeps `data.db` and deletes only the @tursodatabase/sync
 * sidecars, relying on "the next pull re-bootstraps from Turso". That was an assumption,
 * not a step: `openSpec` decides `bootstrapIfEmpty` from `fs.existsSync(localPath)`, so a
 * repaired-but-empty file looks like an established replica and is never seeded. The result
 * is a database that reports healthy forever while serving zero rows.
 *
 * This marker turns that assumption into durable state:
 * - written to disk *before* any sidecar delete, so a crash mid-repair fails safe
 * - read at open time to force `bootstrapIfEmpty`
 * - cleared only after a pull is verified to have produced rows
 *
 * It lives outside `data.db` on purpose — a corrupted database must not be able to claim
 * it was bootstrapped.
 */

import * as fs from "fs";
import Database from "better-sqlite3";

const MARKER_SUFFIX = "-papr-bootstrap-pending";
const SNAPSHOT_SUFFIX = "-papr-presnapshot";

/** Tables that carry no user rows and must never gate "is this replica populated". */
export const REPLICA_NON_USER_TABLES = new Set([
  "schema_migrations",
  "_papr_sync_log",
]);

export type BootstrapPendingReason =
  | "sidecar_wedge_repair"
  | "pre_sync_sidecar_reset"
  | "checkpoint_error_repair"
  | "legacy_cutover"
  /** Cross-namespace copy — local replica rows came from another namespace's Turso. */
  | "cross_namespace_copy"
  /** Community/team install — bundled replica SQLite from publisher workspace. */
  | "portable_install";

export interface BootstrapPendingMarker {
  reason: BootstrapPendingReason;
  /** User rows present at repair time. 0 proves nothing local can be lost. */
  rowsAtRepair: number;
  /** Present only when rowsAtRepair > 0 and the snapshot succeeded. */
  snapshotPath?: string;
  writtenAtMs: number;
  /** Persisted so retry backoff survives quit/relaunch (in-memory cooldowns do not). */
  attempts: number;
  lastAttemptMs?: number;
  lastError?: string;
}

export function bootstrapMarkerPath(dbPath: string): string {
  return `${dbPath}${MARKER_SUFFIX}`;
}

export function bootstrapSnapshotPath(dbPath: string): string {
  return `${dbPath}${SNAPSHOT_SUFFIX}`;
}

/** List user tables (excludes sqlite internals and bookkeeping tables). */
export function listUserTables(db: Database.Database): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as Array<{ name: string }>;
  return rows
    .map((r) => r.name)
    .filter((name) => isReplicaUserDataTable(name));
}

export function isReplicaUserDataTable(tableName: string): boolean {
  return (
    !REPLICA_NON_USER_TABLES.has(tableName) && !tableName.startsWith("turso_")
  );
}

/**
 * Count user rows without going through the sync engine.
 *
 * Reads are safe on a replica file even while the engine holds it — this is the same
 * access pattern the wedge inspector already uses. Returns -1 when the file cannot be
 * read at all, which callers must treat as "unknown", never as "empty".
 */
export function countUserRows(dbPath: string): number {
  if (!fs.existsSync(dbPath)) {
    return 0;
  }
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    let total = 0;
    for (const table of listUserTables(db)) {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM "${table}"`)
        .get() as { n?: number } | undefined;
      total += typeof row?.n === "number" ? row.n : 0;
    }
    return total;
  } catch {
    return -1;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Copy the current replica contents aside before a destructive reset.
 *
 * `VACUUM INTO` is a single atomic statement against a read snapshot, so it does not need
 * the sync engine to be closed and cannot half-write. Returns null when the copy failed —
 * repair still proceeds, but the marker records that nothing was preserved.
 */
function snapshotLocalRows(dbPath: string): string | null {
  const target = bootstrapSnapshotPath(dbPath);
  let db: Database.Database | null = null;
  try {
    fs.rmSync(target, { force: true });
    db = new Database(dbPath, { readonly: true });
    db.prepare("VACUUM INTO ?").run(target);
    return fs.existsSync(target) ? target : null;
  } catch (error) {
    console.warn(
      `[TursoReplicaBootstrap] Snapshot failed for ${dbPath}: ${(error as Error).message}`,
    );
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Record that this replica needs a bootstrap, preserving local rows when there are any.
 *
 * MUST be called before deleting sidecars. Marker-then-delete fails safe (an unnecessary
 * re-download); delete-then-marker reintroduces the original silent-empty bug.
 */
export function writeBootstrapPendingMarker(
  dbPath: string,
  reason: BootstrapPendingReason,
): BootstrapPendingMarker {
  const rows = countUserRows(dbPath);
  // -1 (unreadable) is treated as "might hold data" — snapshot attempt is cheap, data loss is not.
  const snapshotPath = rows !== 0 ? (snapshotLocalRows(dbPath) ?? undefined) : undefined;
  const marker: BootstrapPendingMarker = {
    reason,
    rowsAtRepair: rows,
    snapshotPath,
    writtenAtMs: Date.now(),
    attempts: 0,
  };
  try {
    fs.writeFileSync(bootstrapMarkerPath(dbPath), JSON.stringify(marker), "utf8");
  } catch (error) {
    console.warn(
      `[TursoReplicaBootstrap] Could not write marker for ${dbPath}: ${(error as Error).message}`,
    );
  }
  return marker;
}

export function readBootstrapPendingMarker(dbPath: string): BootstrapPendingMarker | null {
  try {
    const raw = fs.readFileSync(bootstrapMarkerPath(dbPath), "utf8");
    return JSON.parse(raw) as BootstrapPendingMarker;
  } catch {
    return null;
  }
}

/** Cheap enough for the open path — a single stat next to work that already parses `-info`. */
export function hasBootstrapPendingMarker(dbPath: string): boolean {
  return fs.existsSync(bootstrapMarkerPath(dbPath));
}

/** Record a failed bootstrap attempt so backoff survives relaunch. */
export function noteBootstrapAttemptFailed(dbPath: string, error: string): void {
  const marker = readBootstrapPendingMarker(dbPath);
  if (!marker) {
    return;
  }
  const next: BootstrapPendingMarker = {
    ...marker,
    attempts: marker.attempts + 1,
    lastAttemptMs: Date.now(),
    lastError: error.slice(0, 500),
  };
  try {
    fs.writeFileSync(bootstrapMarkerPath(dbPath), JSON.stringify(next), "utf8");
  } catch {
    /* best effort */
  }
}

/** Exponential backoff capped at 15min, derived from persisted attempts. */
export function bootstrapRetryReadyAtMs(marker: BootstrapPendingMarker): number {
  if (!marker.lastAttemptMs) {
    return 0;
  }
  const delay = Math.min(15 * 60_000, 5_000 * 2 ** Math.min(marker.attempts, 8));
  return marker.lastAttemptMs + delay;
}

/** Clear marker and snapshot. Only call after a bootstrap has been verified. */
export function clearBootstrapPendingMarker(dbPath: string): void {
  const marker = readBootstrapPendingMarker(dbPath);
  try {
    fs.rmSync(bootstrapMarkerPath(dbPath), { force: true });
  } catch {
    /* absent */
  }
  if (marker?.snapshotPath) {
    try {
      fs.rmSync(marker.snapshotPath, { force: true });
    } catch {
      /* absent */
    }
  }
}
