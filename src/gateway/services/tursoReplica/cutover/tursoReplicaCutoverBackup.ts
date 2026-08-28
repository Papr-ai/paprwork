/**
 * Pre-cutover backup for legacy SQLite files.
 */

import * as fs from "fs";
import * as path from "path";

const BACKUP_SUFFIX = ".pre-replica.bak";

export function preReplicaBackupPath(dbPath: string): string {
  return dbPath + BACKUP_SUFFIX;
}

/** Copy main db + WAL/SHM sidecars before destructive cutover steps. */
export async function backupLocalDbPreReplica(
  dbPath: string,
): Promise<string | undefined> {
  if (!fs.existsSync(dbPath)) {
    return undefined;
  }

  const backupPath = preReplicaBackupPath(dbPath);
  await fs.promises.mkdir(path.dirname(backupPath), { recursive: true });
  await fs.promises.copyFile(dbPath, backupPath);

  for (const suffix of ["-wal", "-shm"] as const) {
    const sidecar = dbPath + suffix;
    if (fs.existsSync(sidecar)) {
      await fs.promises.copyFile(sidecar, backupPath + suffix);
    }
  }

  return backupPath;
}

/** Restore main db + sidecars from `.pre-replica.bak` after a failed cutover provision. */
export async function restoreLocalDbFromPreReplicaBackup(
  dbPath: string,
): Promise<boolean> {
  const backupPath = preReplicaBackupPath(dbPath);
  if (!fs.existsSync(backupPath)) {
    return false;
  }

  await fs.promises.copyFile(backupPath, dbPath);

  for (const suffix of ["-wal", "-shm"] as const) {
    const backupSidecar = backupPath + suffix;
    const targetSidecar = dbPath + suffix;
    if (fs.existsSync(backupSidecar)) {
      await fs.promises.copyFile(backupSidecar, targetSidecar);
    } else {
      try {
        fs.unlinkSync(targetSidecar);
      } catch {
        /* absent */
      }
    }
  }

  return true;
}
