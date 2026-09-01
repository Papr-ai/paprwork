/** Shared agent-facing messages for Plan A cloud DB authority. */

export const SCHEMA_VIA_MIGRATION_MSG =
  "Plan A (cloud sync): schema changes must use migrations/*.sql + papr_db_apply_migration. " +
  "papr_db_exec accepts DML only (INSERT/UPDATE/DELETE). " +
  "Never use bash/sqlite3 or raw DDL exec on registry databases.";

export const SCHEMA_REQUIRES_ONLINE_MSG =
  "Plan A (cloud sync): raw DDL via papr_db_exec requires Turso primary (online). " +
  "Schema migrations may be applied offline (provisional, pendingPush) via papr_db_apply_migration. " +
  "If cloud schema is ahead after reconnect, use repair_cloud_sync({ strategy: 'merge_lww' | 'accept_cloud' }).";

export const REPLICA_BASH_SQLITE_MSG =
  "Plan A (cloud sync): do not open replica-managed database files with sqlite3 or Python sqlite. " +
  "Even a plain SELECT opens the file read-write and truncates the WAL on close, which wedges sync in both directions. " +
  "Use papr_db_apply_migration for schema, papr_db_exec or /api/db/write for rows, and query_cloud_turso or papr_db_sync_status to inspect. " +
  'If you must read the local file, open it read-only: sqlite3 "file:/path/data.db?mode=ro" "SELECT ..."';

export function isPlanACloudEnvFromProcessEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const replica = env.PAPR_TURSO_REPLICA_SYNC?.trim().toLowerCase();
  const replicaOn =
    replica === "force" ||
    replica === "true" ||
    replica === "1" ||
    replica === "replica-records" ||
    replica === "records";
  // Match gateway isCloudSyncEnabled(): off only when explicitly "false"
  const cloud = env.CLOUD_SYNC_ENABLED?.trim().toLowerCase();
  const cloudOff = cloud === "false" || cloud === "0";
  return replicaOn && !cloudOff;
}
