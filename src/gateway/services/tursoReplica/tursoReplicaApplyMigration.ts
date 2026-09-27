/**
 * Plan A migrations via local Turso Sync replica: exec → push (Turso-native path).
 */

import type { AppDataSource } from "../appDataSources.js";
import { readMigrationSql } from "../jobs/jobMigrationManifest.js";
import { splitSqlStatements } from "../jobs/migrationSqlHelpers.js";
import { localLedgerStatements } from "../jobs/migrationAtomicApply.js";
import { migrationSatisfiedOnReplica } from "./tursoReplicaMigrationVerify.js";
import { isMigrationLedgerMarker } from "../jobs/migrationLedgerPolicy.js";
import { isTursoReplicaOnline } from "../../utils/tursoReplicaEnabled.js";
import {
  migrateLinkedDbViaTursoReplica,
  pullLinkedDbViaTursoReplica,
  queryLinkedDbViaTursoReplica,
} from "./tursoReplicaRouting.js";

async function migrationRecordedInLedger(
  source: AppDataSource,
  migrationId: string,
): Promise<boolean> {
  for (const ledgerId of [migrationId, `${migrationId}.sql`]) {
    const result = await queryLinkedDbViaTursoReplica(
      source,
      "SELECT id FROM schema_migrations WHERE id = ? LIMIT 1",
      [ledgerId],
      { pullBeforeRead: false },
    );
    if (result.rows.length > 0) {
      return true;
    }
  }
  return false;
}

async function migrationSchemaSatisfiedOnLocalReplica(
  source: AppDataSource,
  migrationRoot: string,
  migrationId: string,
): Promise<boolean> {
  return migrationSatisfiedOnReplica(source, migrationRoot, migrationId);
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
  const outcome = await migrateLinkedDbViaTursoReplica(
    source,
    statements,
    localLedgerStatements(migrationId),
  );
  const pendingPush = outcome.pendingPush;

  const schemaOk =
    isMigrationLedgerMarker(migrationId) ||
    (await migrationSchemaSatisfiedOnLocalReplica(source, migrationRoot, migrationId));
  if (!schemaOk) {
    console.warn(
      `[TursoReplica] ${migrationId} committed atomically but post-apply schema verification ` +
        "did not confirm it. Run papr_db_migration_parity if the app misbehaves.",
    );
  }

  return { applied: true, migrationId, pendingPush };
}
