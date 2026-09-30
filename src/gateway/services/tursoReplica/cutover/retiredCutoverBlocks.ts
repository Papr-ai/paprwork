/**
 * Cutover blocks that record a failure the code can no longer produce.
 *
 * `blockCutover` writes why an attempt failed, and nothing re-examines that
 * verdict: `classifyRecordForReplicaCutover` buckets a blocked record as
 * "blocked" and returns before reaching any real check, and the automatic
 * cutover pass does not pass `forceRetry`. Only an explicit user action
 * ("Upload now", `repair_cloud_sync`) clears it.
 *
 * That is correct while the cause still exists and wrong the moment a fix
 * makes it impossible — the block outlives the bug that wrote it and pins the
 * database to the legacy sync path indefinitely. Fixing the cause does not
 * retract the blocks the cause already caused, so they have to be retired
 * explicitly.
 */

const SCHEMA_DRIFT_HEAL_PREFIX = "__schema_drift_heal__";

/** `Migration SQL missing for <id>` — the id is what decides if it is retired. */
const MISSING_MIGRATION_SQL = /Migration SQL missing for (\S+)/;

/**
 * True when the reason names a failure the current code cannot reach.
 *
 * Today that is one case: `replayMigration` used to throw `Migration SQL
 * missing` for a synthetic `__schema_drift_heal__*` id whose manifest entry
 * had been pruned or written on another device. Those ids never have a .sql
 * file by design, and their ops were already applied remotely when the heal
 * shipped, so `jobMigrationTursoSync` now treats them as a no-op. A block
 * citing one is a fossil of the old behaviour.
 *
 * Deliberately narrow: it matches the drift-heal id specifically, so a genuine
 * missing migration — where the SQL really is needed and really is gone —
 * stays blocked.
 */
export function isRetiredCutoverBlockReason(
  reason: string | undefined,
): boolean {
  if (!reason) return false;
  const match = MISSING_MIGRATION_SQL.exec(reason);
  if (!match?.[1]) return false;
  return match[1].startsWith(SCHEMA_DRIFT_HEAL_PREFIX);
}
