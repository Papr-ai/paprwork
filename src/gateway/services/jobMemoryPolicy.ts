/**
 * Policy: may a job's RAW database rows be written to Papr Memory?
 *
 * Default: NO.
 *
 * WHY
 * ---
 * `JobDatabaseMemorySync` writes two memories after every job run:
 *
 *   1. job_database_snapshot — up to 8KB of sample rows as JSON, with the
 *      run id embedded in the content. This path is what this flag disables.
 *   2. job_database_summary  — row counts and column names per table. Kept,
 *      and replaced by the capability card (see jobCapabilityCard.ts).
 *
 * Measured cost of path 1 in one namespace (2026-09-11 Parse census):
 *
 *     job/db-sync rows                       5,721
 *     characters stored                 26,488,636
 *     share of all namespace rows             6.1%
 *     exact-duplicate rows              1,028 (18%)
 *     readers that TARGET this content            0 of 7 search call sites
 *
 * Three compounding defects made this unbounded:
 *
 *   - Alphabetical truncation. listUserTables() does ORDER BY name and takes
 *     MAX_TABLES=8, but SYSTEM_TABLES excludes only 4 names -- `_papr_*` and
 *     `__turso_*` are not among them, and `_` sorts before letters. For the
 *     "Calendar Reader" job, six of eight slots went to sync plumbing and
 *     `calendar_events` -- the actual payload -- was cut off entirely.
 *   - The run id is inside the content, so every run hashes differently and
 *     the content-hash guard can never suppress it.
 *   - No reader. No search call site filters for this content_type, but three
 *     unfiltered KnowledgeGraphWikiService searches CAN return it -- so raw
 *     `_papr_sync_log` dumps compete for max_memories slots against genuine
 *     user memories on "who is X" and "what projects exist".
 *
 * WHY A FLAG RATHER THAN DELETING THE CODE
 * ----------------------------------------
 * Same reasoning as codeIndexPolicy: one env var re-enables the old behaviour
 * for measurement without a revert, and the extraction helpers stay exercised.
 *
 * Set PAPR_JOB_RAW_DB_MEMORY_SYNC=1 to restore the old behaviour.
 */

/** Values accepted as "on". Anything else, including unset, is off. */
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * True only when raw job database rows may be written to Papr Memory.
 *
 * Read at call time, not module load, so tests and a running gateway can flip
 * it without a restart.
 */
export function isRawJobDatabaseMemorySyncEnabled(): boolean {
  const raw = process.env.PAPR_JOB_RAW_DB_MEMORY_SYNC;
  if (!raw) {
    return false;
  }
  return TRUTHY.has(raw.trim().toLowerCase());
}

/** Single log line per process, so a disabled writer is visible but not noisy. */
let announced = false;

export function announceJobMemoryPolicyOnce(): void {
  if (announced) {
    return;
  }
  announced = true;

  if (isRawJobDatabaseMemorySyncEnabled()) {
    console.warn(
      "[jobMemoryPolicy] PAPR_JOB_RAW_DB_MEMORY_SYNC=1 — raw job database rows WILL be written to Papr Memory. " +
        "This path produced 6.1% of namespace rows with no reader; expect duplicate growth.",
    );
  } else {
    console.log(
      "[jobMemoryPolicy] raw job database snapshots disabled (default). Capability cards are written instead.",
    );
  }
}
