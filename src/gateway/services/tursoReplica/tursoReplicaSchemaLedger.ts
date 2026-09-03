/**
 * schema_migrations ledger on Turso Sync replica files (Plan A).
 * Online and offline: local replica exec + push (Turso-native sync path).
 */

import type { AppDataSource } from "../appDataSources.js";
import { normalizeMigrationId } from "../jobs/migrationIdNormalize.js";
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

/**
 * Remove legacy duplicate ledger rows where both `0001_foo` and `0001_foo.sql`
 * exist. Keeps the bare id (canonical form used by papr_db_apply_migration).
 */
export async function dedupeReplicaMigrationLedger(
  source: AppDataSource,
): Promise<{ removed: string[] }> {
  if (isTursoReplicaOnline()) {
    await pullLinkedDbViaTursoReplica(source);
  }

  const result = await queryLinkedDbViaTursoReplica(
    source,
    "SELECT id FROM schema_migrations ORDER BY id ASC",
    [],
    { pullBeforeRead: false },
  );
  const rawIds = result.rows
    .map((row) => String(row.id ?? "").trim())
    .filter((id) => id.length > 0);
  const rawSet = new Set(rawIds);

  const toRemove: string[] = [];
  for (const id of rawIds) {
    if (!id.toLowerCase().endsWith(".sql")) {
      continue;
    }
    const bare = normalizeMigrationId(id);
    if (rawSet.has(bare)) {
      toRemove.push(id);
    }
  }

  for (const id of toRemove) {
    await writeLinkedDbViaTursoReplica(
      source,
      "DELETE FROM schema_migrations WHERE id = ?",
      [id],
    );
  }

  return { removed: toRemove };
}
