/**
 * Recover wedged job scratch SQLite (run history / events) without blocking registry writes.
 */

import { promises as fs } from "fs";
import { isJobScratchDatabasePath } from "./jobScratchDatabasePath.js";
import { isTursoLocalDatabaseCorruptError } from "../tursoSyncBridgeCore.js";
import { isReplicaManagedDbPath } from "../tursoReplica/tursoReplicaFileGuard.js";

const SCRATCH_SIDEcar_SUFFIXES = ["-wal", "-shm"] as const;

function isRecoverableJobScratchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (isTursoLocalDatabaseCorruptError(message)) {
    return true;
  }
  return message.includes("Database file is corrupt or empty");
}

/** Backup then remove corrupt job scratch file + WAL/SHM so scaffold can recreate. */
export async function recoverCorruptJobScratchDatabase(
  dbPath: string,
): Promise<boolean> {
  if (!isJobScratchDatabasePath(dbPath)) {
    return false;
  }
  // A replica's local database is not scratch to be thrown away. This removes
  // data.db, -wal and -shm but leaves the engine's own sidecars (-changes, -info)
  // behind, so the engine is left pointing at a file that no longer exists and the
  // scaffold then recreates it with legacy tables — which is how one file ends up
  // holding both engines' tables. Replica repair belongs to the crash remedy.
  if (isReplicaManagedDbPath(dbPath)) {
    return false;
  }

  const stamp = Date.now();
  try {
    await fs.access(dbPath);
    await fs.copyFile(dbPath, `${dbPath}.sync-backup-${stamp}`);
  } catch {
    /* missing main file */
  }

  for (const suffix of ["", ...SCRATCH_SIDEcar_SUFFIXES]) {
    const target = dbPath + suffix;
    try {
      await fs.unlink(target);
    } catch {
      /* absent */
    }
  }

  return true;
}

/**
 * Whether a migration failure should be answered by rebuilding the file.
 *
 * Guarded here as well as in the recovery itself because the caller acts on *this*
 * answer: a false sends the original error up, while a true makes it rebuild and
 * re-run migrations regardless of what the recovery returned. So declining only in
 * the recovery would still leave a replica's corruption swallowed and its migrations
 * re-applied by the wrong engine.
 */
export function shouldRecoverJobScratchAfterMigrationError(
  dbPath: string,
  error: unknown,
): boolean {
  return (
    isJobScratchDatabasePath(dbPath) &&
    !isReplicaManagedDbPath(dbPath) &&
    isRecoverableJobScratchError(error)
  );
}
