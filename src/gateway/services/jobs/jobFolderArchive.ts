/**
 * Move a job folder out of the live Jobs/ tree into backups/ (gitignored).
 *
 * Anything left under Jobs/ is a candidate for the startup folder scan, so
 * deleted or migrated jobs must leave it — but stay recoverable.
 */

import { existsSync } from "fs";
import { promises as fs } from "fs";
import path from "path";

export type JobArchiveKind = "deleted-jobs" | "migrated-jobs";

export async function moveJobDirToBackups(
  jobDir: string,
  paprDir: string,
  kind: JobArchiveKind,
): Promise<string | null> {
  if (!existsSync(jobDir)) {
    return null;
  }
  const destRoot = path.join(paprDir, "backups", kind);
  await fs.mkdir(destRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(destRoot, `${path.basename(jobDir)}-${stamp}`);
  try {
    await fs.rename(jobDir, dest);
  } catch (err) {
    // Cross-device or locked: copy then remove.
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await fs.cp(jobDir, dest, { recursive: true });
    await fs.rm(jobDir, { recursive: true, force: true });
  }
  return dest;
}
