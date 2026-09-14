/**
 * Recover wedged job scratch SQLite (run history / events) without blocking registry writes.
 */

import { promises as fs } from "fs";
import { isJobScratchDatabasePath } from "./jobScratchDatabasePath.js";
import { isTursoLocalDatabaseCorruptError } from "../tursoSyncBridgeCore.js";

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

export function shouldRecoverJobScratchAfterMigrationError(
  dbPath: string,
  error: unknown,
): boolean {
  return (
    isJobScratchDatabasePath(dbPath) && isRecoverableJobScratchError(error)
  );
}
