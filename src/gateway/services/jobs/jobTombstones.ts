/**
 * Persist deleted job IDs so git/metadata merge cannot resurrect them locally.
 */

import { promises as fs } from "fs";
import path from "path";

export const JOB_TOMBSTONES_FILENAME = ".job-tombstones.json";

export interface JobTombstonesFile {
  removedJobIds: string[];
  updatedAt: string;
}

function tombstonesPath(paprDir: string): string {
  return path.join(paprDir, "data", JOB_TOMBSTONES_FILENAME);
}

export async function readJobTombstones(paprDir: string): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(tombstonesPath(paprDir), "utf8");
    const parsed = JSON.parse(raw) as JobTombstonesFile;
    if (!Array.isArray(parsed.removedJobIds)) {
      return new Set();
    }
    return new Set(parsed.removedJobIds.filter((id) => typeof id === "string" && id.trim()));
  } catch {
    return new Set();
  }
}

// Parallel deletes in one process read-modify-write the same file. Serialize
// per path so no update is lost and two writers never share a temp file.
const writeChains = new Map<string, Promise<void>>();

export async function addJobTombstones(
  paprDir: string,
  jobIds: string[],
): Promise<void> {
  const key = tombstonesPath(paprDir);
  const prev = writeChains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => writeJobTombstones(paprDir, jobIds));
  writeChains.set(key, next);
  try {
    await next;
  } finally {
    if (writeChains.get(key) === next) writeChains.delete(key);
  }
}

/**
 * Remove job IDs from the tombstone list. Use only on explicit user intent to
 * have those jobs again: installing or updating an app that ships them. A
 * track install keeps the publisher's job IDs, so an earlier install of the
 * same app that was deleted left them tombstoned, and the reinstalled jobs
 * were dropped on the next reload with no error (the scheduler never fired).
 * Returns the IDs that were actually removed.
 */
export async function clearJobTombstones(
  paprDir: string,
  jobIds: string[],
): Promise<string[]> {
  const wanted = new Set(jobIds.map((id) => id.trim()).filter(Boolean));
  if (wanted.size === 0) {
    return [];
  }
  const key = tombstonesPath(paprDir);
  let cleared: string[] = [];
  const prev = writeChains.get(key) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      const existing = await readJobTombstones(paprDir);
      cleared = [...wanted].filter((id) => existing.has(id));
      if (cleared.length === 0) {
        return;
      }
      for (const id of cleared) {
        existing.delete(id);
      }
      await writeTombstoneSet(paprDir, existing);
    });
  writeChains.set(key, next);
  try {
    await next;
  } finally {
    if (writeChains.get(key) === next) writeChains.delete(key);
  }
  return cleared;
}

async function writeJobTombstones(paprDir: string, jobIds: string[]): Promise<void> {
  const incoming = jobIds.map((id) => id.trim()).filter(Boolean);
  if (incoming.length === 0) {
    return;
  }

  const existing = await readJobTombstones(paprDir);
  for (const id of incoming) {
    existing.add(id);
  }

  await writeTombstoneSet(paprDir, existing);
}

async function writeTombstoneSet(paprDir: string, existing: Set<string>): Promise<void> {
  const target = tombstonesPath(paprDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const payload: JobTombstonesFile = {
    removedJobIds: [...existing].sort(),
    updatedAt: new Date().toISOString(),
  };
  // Atomic write: a crash mid-write must never leave a truncated file that
  // readJobTombstones() parses as "no tombstones" and resurrects every deleted job.
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tmp, target);
}
