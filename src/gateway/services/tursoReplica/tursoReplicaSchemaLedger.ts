/**
 * schema_migrations ledger on Turso Sync replica files (Plan A).
 * Online and offline: local replica exec + push (Turso-native sync path).
 */

import type { AppDataSource } from "../appDataSources.js";
import { isTursoReplicaOnline } from "../../utils/tursoReplicaEnabled.js";
import {
  execLinkedDbViaTursoReplica,
  pullLinkedDbViaTursoReplica,
  queryLinkedDbViaTursoReplica,
  writeLinkedDbViaTursoReplica,
} from "./tursoReplicaRouting.js";

export const REPLICA_SCHEMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
)`;

export const BASELINE_MIGRATION_ID = "0001_baseline";

export async function replicaHasSchemaMigrationsTable(
  source: AppDataSource,
): Promise<boolean> {
  const result = await queryLinkedDbViaTursoReplica(
    source,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations' LIMIT 1",
    [],
    { pullBeforeRead: false },
  );
  return result.rows.length > 0;
}

async function ensureBaselineOnLocalReplica(source: AppDataSource): Promise<void> {
  const hasTable = await replicaHasSchemaMigrationsTable(source);
  if (!hasTable) {
    await execLinkedDbViaTursoReplica(source, REPLICA_SCHEMA_MIGRATIONS_DDL);
  }

  await writeLinkedDbViaTursoReplica(
    source,
    "INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))",
    [BASELINE_MIGRATION_ID],
  );
}

/** Ensure migration ledger exists via local replica (pull first when online). */
export async function ensureReplicaSchemaMigrationsLedger(
  source: AppDataSource,
): Promise<void> {
  if (isTursoReplicaOnline()) {
    await pullLinkedDbViaTursoReplica(source);
  }
  await ensureBaselineOnLocalReplica(source);
}
