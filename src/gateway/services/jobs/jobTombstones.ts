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

export async function addJobTombstones(
  paprDir: string,
  jobIds: string[],
): Promise<void> {
  const incoming = jobIds.map((id) => id.trim()).filter(Boolean);
  if (incoming.length === 0) {
    return;
  }

  const existing = await readJobTombstones(paprDir);
  for (const id of incoming) {
    existing.add(id);
  }

  const target = tombstonesPath(paprDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const payload: JobTombstonesFile = {
    removedJobIds: [...existing].sort(),
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
