/**
 * Keep the legacy better-sqlite3 job writer off a job database the sync engine owns.
 *
 * A job database can be cut over to the replica engine: the registry then carries
 * `syncMode: "replica"` for `Jobs/{id}/data/data.db`, and the engine keeps its own
 * tables (`turso_cdc`, `turso_cdc_version`, `turso_sync_last_change_id`) in that
 * same file. `JobDatabase` predates the cutover and writes run telemetry with
 * better-sqlite3, so on such a file two SQLite engines write one set of btrees —
 * which aborts the process rather than raising, since the panic is in native Rust.
 *
 * The trade this makes deliberately: a cut-over job stops recording `job_runs` and
 * `job_events` locally until that telemetry is routed through the engine. Missing
 * telemetry is recoverable; the alternative is losing the job's actual data, because
 * the corruption remedy deletes the file.
 */

import { isReplicaManagedDbPath } from "../tursoReplica/tursoReplicaFileGuard.js";

/** Paths already reported, so a per-run write path logs once rather than per call. */
const reported = new Set<string>();

/**
 * True when `dbPath` belongs to the sync engine and the legacy writer must stand down.
 * Reports the decision once per path — silence here looks identical to a job that
 * simply produced no events.
 */
export function shouldSkipLegacyJobScratchWrite(
  dbPath: string,
  operation: string,
): boolean {
  if (!isReplicaManagedDbPath(dbPath)) {
    return false;
  }
  if (!reported.has(dbPath)) {
    reported.add(dbPath);
    console.warn(
      `[JobDatabase] ${operation} skipped for ${dbPath}: this job database is ` +
        "owned by the Turso sync engine, so better-sqlite3 must not write to it. " +
        "Run history and events are not recorded locally for this job.",
    );
  }
  return true;
}

/** Test seam — the report set is process-lifetime state. */
export function resetLegacyJobScratchWriteReportsForTests(): void {
  reported.clear();
}
