/** Shared agent-facing messages for Plan A cloud DB authority. */

export const SCHEMA_VIA_MIGRATION_MSG =
  "Plan A (cloud sync): schema changes must use migrations/*.sql + papr_db_apply_migration. " +
  "papr_db_exec accepts DML only (INSERT/UPDATE/DELETE). " +
  "Never use bash/sqlite3 or raw DDL exec on registry databases.";

export const SCHEMA_REQUIRES_ONLINE_MSG =
  "Plan A (cloud sync): raw DDL via papr_db_exec requires Turso primary (online). " +
  "Schema migrations: papr_db_apply_migration (replica → Turso primary HTTP → pull). " +
  "If cloud schema diverged, use papr_db_migration_parity + papr_db_reconcile_sync — not merge_lww.";

export const REPLICA_BASH_SQLITE_MSG =
  "Plan A: registry DBs have two tiers — **replica** (desktop embedded sync handle) and **cloud** (Turso primary). " +
  "Do not open data.db with sqlite3 or Python sqlite — even SELECT wedges sync. " +
  "Inspect replica: papr_db_exec / app backend (backend turso-replica). Inspect cloud: query_cloud_turso. " +
  'Emergency read-only file peek: sqlite3 "file:/path/data.db?mode=ro" — NOT authoritative for replica state.';

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
