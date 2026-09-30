/**
 * Job scratch layout: Jobs/{jobId}/data/data.db (infra runs/events only).
 * Registry layout: .../data/databases/{slug}/data.db — never treat as job scratch.
 */

import path from "path";

/** True for Jobs/{id}/data/data.db paths (local-only scratch, not Turso Plan A). */
export function isJobScratchDatabasePath(dbPath: string): boolean {
  const normalized = path.normalize(dbPath);
  if (path.basename(normalized) !== "data.db") {
    return false;
  }
  const parentDir = path.dirname(normalized);
  if (path.basename(parentDir) !== "data") {
    return false;
  }
  const jobDir = path.dirname(parentDir);
  return path.basename(path.dirname(jobDir)) === "Jobs";
}
