/**
 * Plan A — keep legacy better-sqlite3 CDC off Turso Sync replica files.
 */

import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";
import {
  getDatabaseRegistryService,
  type DatabaseRecord,
} from "../DatabaseRegistryService.js";
import {
  isTursoReplicaSyncFeatureEnabled,
  shouldUseTursoReplicaForDb,
} from "../../utils/tursoReplicaEnabled.js";

const REPLICA_SIDEcar_SUFFIXES = [
  "-changes",
  "-info",
  "-wal-revert",
  "-wal",
  "-shm",
] as const;

/** True when this local path is owned by Plan A (@tursodatabase/sync). */
export function isReplicaManagedDbPath(dbPath: string): boolean {
  if (!isTursoReplicaSyncFeatureEnabled()) {
    return false;
  }
  const normalized = path.normalize(dbPath);
  const registry = getDatabaseRegistryService();
  const record = registry.getByPath(normalized);
  if (!record) {
    return false;
  }
  return shouldUseTursoReplicaForDb({ syncMode: record.syncMode });
}

export function isReplicaManagedRecord(record: DatabaseRecord): boolean {
  return (
    isTursoReplicaSyncFeatureEnabled() &&
    shouldUseTursoReplicaForDb({ syncMode: record.syncMode })
  );
}

/** Block legacy better-sqlite3 writes on Plan A replica files (single-engine enforcement). */
export class ReplicaManagedDbAccessError extends Error {
  constructor(dbPath: string, operation: string) {
    super(
      `Plan A replica DB at ${dbPath} must use @tursodatabase/sync — ` +
        `${operation} via better-sqlite3 is blocked. ` +
        "Use papr_db_apply_migration / papr_db_exec / /api/db/* instead.",
    );
    this.name = "ReplicaManagedDbAccessError";
  }
}

export function assertNotReplicaManagedWritablePath(
  dbPath: string,
  operation: string,
): void {
  if (isReplicaManagedDbPath(dbPath)) {
    throw new ReplicaManagedDbAccessError(dbPath, operation);
  }
}

/** Checkpoint WAL into main file before removing sidecars (never unlink a hot -wal). */
export function safeCleanupSqliteSidecars(dbPath: string): void {
  const walPath = dbPath + "-wal";
  let walSize = 0;
  try {
    walSize = fs.statSync(walPath).size;
  } catch {
    walSize = 0;
  }

  if (walSize > 0) {
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath);
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      return;
    } finally {
      try {
        db?.close();
      } catch {
        /* already closed */
      }
    }

    try {
      if (fs.statSync(walPath).size > 0) {
        return;
      }
    } catch {
      /* wal removed by checkpoint */
    }
  }

  for (const suffix of ["-wal", "-shm"] as const) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      /* absent */
    }
  }
}

/** Remove Turso Sync sidecars only — keeps main data.db (cheap repair vs full reseed). */
export function removeTursoReplicaSidecarsOnly(dbPath: string): void {
  safeCleanupSqliteSidecars(dbPath);
  for (const suffix of REPLICA_SIDEcar_SUFFIXES) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      /* absent */
    }
  }
}

/** Remove a Turso Sync replica file set (local db + sync sidecars). */
export function removeTursoReplicaLocalFiles(dbPath: string): void {
  safeCleanupSqliteSidecars(dbPath);
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* absent */
  }
  for (const suffix of REPLICA_SIDEcar_SUFFIXES) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      /* absent */
    }
  }
}
