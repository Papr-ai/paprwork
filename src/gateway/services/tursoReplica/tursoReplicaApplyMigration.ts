/**
 * Plan A migrations via local Turso Sync replica: exec → push (Turso-native path).
 */

import Database from "better-sqlite3";
import type { AppDataSource } from "../appDataSources.js";
import { readMigrationSql } from "../jobs/jobMigrationManifest.js";
import {
  isDuplicateColumnError,
  splitSqlStatements,
} from "../jobs/migrationSqlHelpers.js";
import { migrationSatisfiedOnLocal } from "../jobs/jobMigrationLedgerSync.js";
import { isTursoReplicaOnline } from "../../utils/tursoReplicaEnabled.js";
import {
  execLinkedDbViaTursoReplica,
  pullLinkedDbViaTursoReplica,
  queryLinkedDbViaTursoReplica,
  writeLinkedDbViaTursoReplica,
} from "./tursoReplicaRouting.js";

async function migrationRecordedInLedger(
  source: AppDataSource,
  migrationId: string,
): Promise<boolean> {
  const result = await queryLinkedDbViaTursoReplica(
    source,
    "SELECT id FROM schema_migrations WHERE id = ? LIMIT 1",
    [migrationId],
    { pullBeforeRead: false },
  );
  return result.rows.length > 0;
}

async function migrationSchemaSatisfiedOnLocalReplica(
  source: AppDataSource,
  migrationRoot: string,
  migrationId: string,
): Promise<boolean> {
  const db = new Database(source.dbPath, { readonly: true });
  try {
    return await migrationSatisfiedOnLocal(db, migrationRoot, migrationId);
  } finally {
    db.close();
  }
}

async function migrationAlreadyApplied(
  source: AppDataSource,
  migrationRoot: string,
  migrationId: string,
): Promise<boolean> {
  const recorded = await migrationRecordedInLedger(source, migrationId);
  if (!recorded) {
    return false;
  }
  return migrationSchemaSatisfiedOnLocalReplica(source, migrationRoot, migrationId);
}

/** Apply migrations/{id}.sql on local replica and push when online. */
export async function applyRegistryMigrationViaLocalReplica(
  source: AppDataSource,
  migrationRoot: string,
  migrationFileName: string,
): Promise<{ applied: boolean; migrationId: string; pendingPush: boolean }> {
  const migrationId = migrationFileName.replace(/\.sql$/, "");
  const sql = await readMigrationSql(migrationRoot, migrationFileName);
  if (!sql) {
    throw new Error(
      `Migration file not found: ${migrationRoot}/migrations/${migrationFileName}`,
    );
  }

  if (isTursoReplicaOnline()) {
    await pullLinkedDbViaTursoReplica(source);
  }

  if (await migrationAlreadyApplied(source, migrationRoot, migrationId)) {
    return { applied: false, migrationId, pendingPush: false };
  }

  const statements = splitSqlStatements(sql);
  let pendingPush = false;

  for (const statement of statements) {
    const trimmed = statement.trim().toLowerCase();
    const isDml =
      trimmed.startsWith("insert") ||
      trimmed.startsWith("update") ||
      trimmed.startsWith("delete");

    if (isDml) {
      const result = await writeLinkedDbViaTursoReplica(source, statement);
      pendingPush = pendingPush || result.pendingPush;
    } else {
      try {
        const result = await execLinkedDbViaTursoReplica(source, statement);
        pendingPush = pendingPush || result.pendingPush;
      } catch (error) {
        if (isDuplicateColumnError(error)) {
          continue;
        }
        throw error;
      }
    }
  }

  const schemaOk = await migrationSchemaSatisfiedOnLocalReplica(
    source,
    migrationRoot,
    migrationId,
  );
  if (!schemaOk) {
    throw new Error(
      `Migration ${migrationId} finished but schema verification failed — ` +
        "ledger not updated. Re-run after fixing migration SQL.",
    );
  }

  const ledgerSql =
    "INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))";
  const ledgerResult = await writeLinkedDbViaTursoReplica(source, ledgerSql, [
    migrationId,
  ]);
  pendingPush = pendingPush || ledgerResult.pendingPush;

  return { applied: true, migrationId, pendingPush };
}
