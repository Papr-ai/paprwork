/**
 * Explicit replica + Turso primary migration apply (Plan A).
 * Desktop path: embedded replica. Cloud authority: Turso primary via HTTP.
 */

import type { AppDataSource } from "../appDataSources.js";
import { tursoNameForRecord } from "../DatabaseRegistryService.js";
import { readMigrationSql } from "../jobs/jobMigrationManifest.js";
import {
  applyAndRecordMigrationOnTursoPrimary,
  openTursoPrimaryClient,
} from "../jobs/jobMigrationTursoSync.js";
import {
  isDuplicateColumnError,
  splitSqlStatements,
} from "../jobs/migrationSqlHelpers.js";
import {
  diffTableSets,
  listCloudUserTables,
  listReplicaUserTables,
  migrationSatisfiedOnReplica,
} from "./tursoReplicaMigrationVerify.js";
import { isTursoReplicaOnline } from "../../utils/tursoReplicaEnabled.js";
import { isMigrationLedgerMarker } from "../jobs/migrationLedgerPolicy.js";
import {
  computeMigrationSqlChecksum,
  createMigrationApplyPair,
  getMigrationApplyPair,
  listUnpairedMigrations,
  markMigrationCloudApplied,
  validateMigrationApplyToken,
  type MigrationApplyPairRecord,
} from "./migrationApplyPairing.js";
import {
  execLinkedDbViaTursoReplica,
  pullLinkedDbViaTursoReplica,
  queryLinkedDbViaTursoReplica,
  writeLinkedDbViaTursoReplica,
} from "./tursoReplicaRouting.js";
import {
  checkMigrationPushConflict,
  listLocalOnlyMigrationIds,
  readLocalReplicaMigrationIds,
  readRemoteTursoMigrationIds,
  type MigrationPushConflict,
} from "./tursoReplicaMigrationConflict.js";
import { ensureReplicaSchemaMigrationsLedger } from "./tursoReplicaSchemaLedger.js";
import { detectReplicaSidecarWedge } from "./tursoReplicaSidecarWedge.js";

const REPLICA_NO_PUSH = { pushAfterWrite: false } as const;

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

async function migrationSchemaSatisfiedOnReplica(
  source: AppDataSource,
  migrationRoot: string,
  migrationId: string,
): Promise<boolean> {
  return migrationSatisfiedOnReplica(source, migrationRoot, migrationId);
}

async function migrationAlreadyAppliedOnReplica(
  source: AppDataSource,
  migrationRoot: string,
  migrationId: string,
): Promise<boolean> {
  const recorded = await migrationRecordedInLedger(source, migrationId);
  if (!recorded) {
    return false;
  }
  return migrationSchemaSatisfiedOnReplica(source, migrationRoot, migrationId);
}

function normalizeMigrationId(migrationFileName: string): string {
  return migrationFileName.replace(/\.sql$/, "");
}

async function loadMigrationSql(
  migrationRoot: string,
  migrationFileName: string,
): Promise<string> {
  const sql = await readMigrationSql(migrationRoot, migrationFileName);
  if (!sql) {
    throw new Error(
      `Migration file not found: ${migrationRoot}/migrations/${migrationFileName}`,
    );
  }
  return sql;
}

async function applyStatementsOnReplica(
  source: AppDataSource,
  statements: readonly string[],
): Promise<boolean> {
  let pendingPush = false;
  for (const statement of statements) {
    const trimmed = statement.trim().toLowerCase();
    const isDml =
      trimmed.startsWith("insert") ||
      trimmed.startsWith("update") ||
      trimmed.startsWith("delete");

    if (isDml) {
      const result = await writeLinkedDbViaTursoReplica(
        source,
        statement,
        undefined,
        REPLICA_NO_PUSH,
      );
      pendingPush = pendingPush || result.pendingPush;
    } else {
      try {
        const result = await execLinkedDbViaTursoReplica(
          source,
          statement,
          REPLICA_NO_PUSH,
        );
        pendingPush = pendingPush || result.pendingPush;
      } catch (error) {
        if (isDuplicateColumnError(error)) {
          continue;
        }
        throw error;
      }
    }
  }
  return pendingPush;
}

/** Apply migration SQL on embedded replica only (no push to Turso primary). */
export async function applyRegistryMigrationOnReplicaOnly(
  source: AppDataSource,
  migrationRoot: string,
  migrationFileName: string,
): Promise<{
  applied: boolean;
  migrationId: string;
  pendingPush: boolean;
  applyToken: string;
  sqlChecksum: string;
}> {
  const migrationId = normalizeMigrationId(migrationFileName);
  const sql = await loadMigrationSql(migrationRoot, migrationFileName);
  const sqlChecksum = computeMigrationSqlChecksum(sql);

  if (isTursoReplicaOnline()) {
    await pullLinkedDbViaTursoReplica(source);
  }

  await ensureReplicaSchemaMigrationsLedger(source);

  if (await migrationAlreadyAppliedOnReplica(source, migrationRoot, migrationId)) {
    const pair = await createMigrationApplyPair({
      migrationRoot,
      migrationId,
      sqlChecksum,
      replicaAppliedAt: new Date().toISOString(),
    });
    return {
      applied: false,
      migrationId,
      pendingPush: false,
      applyToken: pair.applyToken,
      sqlChecksum,
    };
  }

  const statements = splitSqlStatements(sql);
  const pendingPush = await applyStatementsOnReplica(source, statements);

  const schemaOk =
    isMigrationLedgerMarker(migrationId) ||
    (await migrationSchemaSatisfiedOnReplica(source, migrationRoot, migrationId));
  if (!schemaOk) {
    throw new Error(
      `Migration ${migrationId} may have applied on the replica backend but ledger was not updated — ` +
        "schema verification against the replica handle failed. " +
        "Do not assume a no-op: run papr_db_migration_parity and inspect replica vs cloud tables. " +
        "Never verify with sqlite3 on data.db — that reads the on-disk file, not the replica handle.",
    );
  }

  await writeLinkedDbViaTursoReplica(
    source,
    "INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))",
    [migrationId],
    REPLICA_NO_PUSH,
  );

  const pair = await createMigrationApplyPair({
    migrationRoot,
    migrationId,
    sqlChecksum,
    replicaAppliedAt: new Date().toISOString(),
  });

  return {
    applied: true,
    migrationId,
    pendingPush,
    applyToken: pair.applyToken,
    sqlChecksum,
  };
}

/** Apply migration SQL on Turso primary (HTTP) — requires matching applyToken from replica apply. */
export async function applyRegistryMigrationOnCloudPrimary(
  source: AppDataSource,
  migrationRoot: string,
  migrationFileName: string,
  applyToken: string,
): Promise<{
  applied: boolean;
  migrationId: string;
  paired: boolean;
  applyToken: string;
}> {
  const migrationId = normalizeMigrationId(migrationFileName);
  const sql = await loadMigrationSql(migrationRoot, migrationFileName);
  const sqlChecksum = computeMigrationSqlChecksum(sql);

  await validateMigrationApplyToken({
    migrationRoot,
    migrationId,
    applyToken,
    sqlChecksum,
  });

  const record = source.dbId
    ? { dbId: source.dbId, tursoShortName: "", isolation: "shared" as const }
    : null;
  if (!record?.dbId) {
    throw new Error("dbId required for cloud primary migration apply");
  }
  const { getDatabaseRegistryService } = await import("../DatabaseRegistryService.js");
  const dbRecord = getDatabaseRegistryService().getById(record.dbId);
  if (!dbRecord) {
    throw new Error(`Database not found: ${record.dbId}`);
  }

  const tursoDatabase = tursoNameForRecord(dbRecord);
  const client = await openTursoPrimaryClient(tursoDatabase);
  try {
    const result = await applyAndRecordMigrationOnTursoPrimary(
      client,
      migrationRoot,
      migrationId,
    );
    const pair = await markMigrationCloudApplied({
      migrationRoot,
      migrationId,
      applyToken,
    });
    return {
      applied: result.applied,
      migrationId,
      paired: pair.pairedAt !== null,
      applyToken: pair.applyToken,
    };
  } finally {
    client.close();
  }
}

/** Pull replica from Turso primary after both sides applied (align sync frames). */
export async function alignReplicaAfterCloudMigration(
  source: AppDataSource,
): Promise<{ pulled: boolean }> {
  if (!isTursoReplicaOnline()) {
    return { pulled: false };
  }
  const pulled = await pullLinkedDbViaTursoReplica(source, { forceReconnect: true });
  return { pulled };
}

/** Combined happy path: replica apply → cloud primary apply → pull align. */
export async function applyRegistryMigrationDualPath(
  source: AppDataSource,
  migrationRoot: string,
  migrationFileName: string,
): Promise<{
  applied: boolean;
  migrationId: string;
  applyToken: string;
  replicaApplied: boolean;
  cloudApplied: boolean;
  paired: boolean;
  pulled: boolean;
}> {
  const replicaResult = await applyRegistryMigrationOnReplicaOnly(
    source,
    migrationRoot,
    migrationFileName,
  );

  let cloudApplied = false;
  if (isTursoReplicaOnline()) {
    const cloudResult = await applyRegistryMigrationOnCloudPrimary(
      source,
      migrationRoot,
      migrationFileName,
      replicaResult.applyToken,
    );
    cloudApplied = cloudResult.applied || cloudResult.paired;
  }

  const pullResult = isTursoReplicaOnline()
    ? await alignReplicaAfterCloudMigration(source)
    : { pulled: false };

  const pair = await getMigrationApplyPair(
    migrationRoot,
    replicaResult.migrationId,
  );

  return {
    applied: replicaResult.applied || cloudApplied,
    migrationId: replicaResult.migrationId,
    applyToken: replicaResult.applyToken,
    replicaApplied: replicaResult.applied || Boolean(pair?.replicaAppliedAt),
    cloudApplied: Boolean(pair?.cloudAppliedAt),
    paired: Boolean(pair?.pairedAt),
    pulled: pullResult.pulled,
  };
}

export interface MigrationParityReport {
  dbId: string;
  migrationRoot: string;
  /** Migration ids recorded on the embedded replica handle. */
  replicaMigrationIds: string[];
  /** Migration ids recorded on Turso primary (cloud). */
  cloudMigrationIds: string[];
  replicaOnlyIds: string[];
  cloudOnlyIds: string[];
  /** User table names visible on the replica handle. */
  replicaTables: string[];
  /** User table names on Turso primary. */
  cloudTables: string[];
  replicaOnlyTables: string[];
  cloudOnlyTables: string[];
  migrationConflict: MigrationPushConflict | null;
  sidecarWedge: boolean;
  unpairedApplies: MigrationApplyPairRecord[];
  /** Ledgers match (schema_migrations ids). */
  ledgerPaired: boolean;
  /** User table sets match between replica and cloud. */
  schemaPaired: boolean;
  /** Both ledger and schema agree. */
  paired: boolean;
}

export async function buildMigrationParityReport(options: {
  source: AppDataSource;
  migrationRoot: string;
  dbId: string;
}): Promise<MigrationParityReport> {
  const { getDatabaseRegistryService } = await import("../DatabaseRegistryService.js");
  const record = getDatabaseRegistryService().getById(options.dbId);
  if (!record) {
    throw new Error(`Database not found: ${options.dbId}`);
  }
  const tursoDatabase = tursoNameForRecord(record);

  const [replicaMigrationIds, cloudMigrationIds, replicaTables, cloudTables] =
    await Promise.all([
      readLocalReplicaMigrationIds(options.source),
      readRemoteTursoMigrationIds(tursoDatabase),
      listReplicaUserTables(options.source),
      listCloudUserTables(tursoDatabase),
    ]);

  const replicaOnlyIds = listLocalOnlyMigrationIds(
    replicaMigrationIds,
    cloudMigrationIds,
  );
  const cloudOnlyIds = listLocalOnlyMigrationIds(
    cloudMigrationIds,
    replicaMigrationIds,
  );

  const migrationConflict = await checkMigrationPushConflict({
    source: options.source,
    tursoDatabase,
  });

  const unpairedApplies = await listUnpairedMigrations(options.migrationRoot);
  const tableDiff = diffTableSets(replicaTables, cloudTables);

  const ledgerPaired =
    replicaOnlyIds.length === 0 &&
    cloudOnlyIds.length === 0 &&
    unpairedApplies.length === 0 &&
    !migrationConflict;

  return {
    dbId: options.dbId,
    migrationRoot: options.migrationRoot,
    replicaMigrationIds,
    cloudMigrationIds,
    replicaOnlyIds,
    cloudOnlyIds,
    replicaTables,
    cloudTables,
    replicaOnlyTables: tableDiff.replicaOnlyTables,
    cloudOnlyTables: tableDiff.cloudOnlyTables,
    migrationConflict,
    sidecarWedge: detectReplicaSidecarWedge(options.source.dbPath),
    unpairedApplies,
    ledgerPaired,
    schemaPaired: tableDiff.schemaPaired,
    paired: ledgerPaired && tableDiff.schemaPaired,
  };
}
