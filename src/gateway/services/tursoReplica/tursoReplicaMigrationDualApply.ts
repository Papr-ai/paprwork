/**
 * Registry migration apply (Plan A).
 * Default path: applyRegistryMigrationSingleRoute — apply once on the embedded
 * replica, push through sync. The replica-only / cloud-primary halves remain as
 * manual recovery tools (papr_db_apply_migration_replica / _cloud).
 */

import type { AppDataSource } from "../appDataSources.js";
import { tursoNameForRecord } from "../DatabaseRegistryService.js";
import { readMigrationSql } from "../jobs/jobMigrationManifest.js";
import {
  applyAndRecordMigrationOnTursoPrimary,
  openTursoPrimaryClient,
} from "../jobs/jobMigrationTursoSync.js";
import { splitSqlStatements } from "../jobs/migrationSqlHelpers.js";
import { localLedgerStatements } from "../jobs/migrationAtomicApply.js";
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
  listUnpairedMigrations,
  markMigrationCloudApplied,
  validateMigrationApplyToken,
  type MigrationApplyPairRecord,
} from "./migrationApplyPairing.js";
import {
  migrateLinkedDbViaTursoReplica,
  pullLinkedDbViaTursoReplica,
  pushLinkedDbViaTursoReplica,
  queryLinkedDbViaTursoReplica,
} from "./tursoReplicaRouting.js";
import { REMOTE_SCHEMA_MIGRATIONS_TABLE } from "../tursoPlatformSchema.js";
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

  // One transaction: every statement (each checked against the live schema
  // first) plus the ledger row. A failure rolls the whole migration back, so a
  // half-applied migration can no longer be left behind for the next run.
  const statements = splitSqlStatements(sql);
  const outcome = await migrateLinkedDbViaTursoReplica(
    source,
    statements,
    localLedgerStatements(migrationId),
    REPLICA_NO_PUSH,
  );
  const pendingPush = outcome.pendingPush;
  for (const skip of outcome.skipped) {
    console.warn(`[TursoReplica] ${migrationId}: skipped (${skip.reason})`);
  }

  const schemaOk =
    isMigrationLedgerMarker(migrationId) ||
    (await migrationSchemaSatisfiedOnReplica(source, migrationRoot, migrationId));
  if (!schemaOk) {
    // Committed atomically, so this is a verifier blind spot, not a partial apply.
    console.warn(
      `[TursoReplica] ${migrationId} committed atomically but post-apply schema verification ` +
        "did not confirm it. Run papr_db_migration_parity if the app misbehaves.",
    );
  }

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

/**
 * `_papr_schema_migrations` rows written on the replica, in the migration's own
 * transaction, so both ledgers reach the cloud through the same push as the
 * schema and seed rows they describe.
 */
export function replicaPaprLedgerStatements(
  migrationId: string,
): Array<{ sql: string; params?: unknown[] }> {
  const table = `"${REMOTE_SCHEMA_MIGRATIONS_TABLE}"`;
  return [
    {
      sql:
        `CREATE TABLE IF NOT EXISTS ${table} (` +
        "id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, " +
        "source TEXT NOT NULL DEFAULT 'database_migration', content_hash TEXT)",
    },
    {
      sql:
        `INSERT OR IGNORE INTO ${table} (id, applied_at, source) ` +
        "VALUES (?, datetime('now'), 'database_migration')",
      params: [migrationId],
    },
  ];
}

/**
 * Single route: apply once on the replica (statements + both ledger rows in one
 * transaction), then push that change to the Turso primary through sync.
 *
 * Replaces the old dual apply (replica with push held + the same SQL again on
 * the primary over HTTP + pull). The sync engine could not tell those two
 * copies apart: on pull it replayed the held replica change over the primary's
 * copy, so non-idempotent seeds (DELETE + INSERT into a UNIQUE table) failed
 * with "failed to replay local change after remote apply", and the replica's
 * schema_migrations row never reached the cloud. Verified against a live Turso
 * database on 2026-10-01 (see tests/migration-single-route.test.ts).
 */
export async function applyRegistryMigrationSingleRoute(
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
  pushed: boolean;
  pushError: string | null;
}> {
  const migrationId = normalizeMigrationId(migrationFileName);
  const sql = await loadMigrationSql(migrationRoot, migrationFileName);
  const sqlChecksum = computeMigrationSqlChecksum(sql);
  const online = isTursoReplicaOnline();
  const hold = await import("./replicaPublishHold.js");
  const { classifyMigrationSql } = await import("../jobs/migrationBreakingClassifier.js");
  const breaking = classifyMigrationSql(sql).breaking;
  // A teammate on the team's shared data: every schema change stays local
  // (proposal hold) — only the publisher migrates the shared cloud copy.
  const { isCollaboratorOnSharedDatabase } = await import("../sharedPrimaryTursoResolve.js");
  const proposal = Boolean(source.dbId && isCollaboratorOnSharedDatabase(source.dbId));
  // Breaking (or anything queued behind a held one): apply locally only, publish carries it to the cloud.
  const holdForPublish =
    proposal ||
    (hold.isBreakingMigrationHoldEnabled() && (breaking || hold.isReplicaHeld(source.dbPath)));
  if (holdForPublish && !hold.isReplicaHeld(source.dbPath) && online) {
    // Upload rows written before the hold: the publish rebuilds this copy from the
    // cloud, so anything not yet uploaded (and not journaled) would be lost.
    const flushed = await pushLinkedDbViaTursoReplica(source);
    if (!flushed.ok) {
      throw new Error(
        `Could not upload pending rows before holding ${migrationId} for publish: ${flushed.error ?? "push failed"}`,
      );
    }
  }

  if (online) {
    await pullLinkedDbViaTursoReplica(source);
  }
  await ensureReplicaSchemaMigrationsLedger(source);

  let applied = false;
  if (!(await migrationAlreadyAppliedOnReplica(source, migrationRoot, migrationId))) {
    const outcome = await migrateLinkedDbViaTursoReplica(
      source,
      splitSqlStatements(sql),
      [...localLedgerStatements(migrationId), ...replicaPaprLedgerStatements(migrationId)],
      // Push explicitly below (pull-first + migration conflict check), not in the write.
      REPLICA_NO_PUSH,
    );
    for (const skip of outcome.skipped) {
      console.warn(`[TursoReplica] ${migrationId}: skipped (${skip.reason})`);
    }
    applied = true;
    const schemaOk =
      isMigrationLedgerMarker(migrationId) ||
      (await migrationSchemaSatisfiedOnReplica(source, migrationRoot, migrationId));
    if (!schemaOk) {
      console.warn(
        `[TursoReplica] ${migrationId} committed atomically but post-apply schema verification ` +
          "did not confirm it. Run papr_db_migration_parity if the app misbehaves.",
      );
    }
  }

  const pair = await createMigrationApplyPair({
    migrationRoot,
    migrationId,
    sqlChecksum,
    replicaAppliedAt: new Date().toISOString(),
  });

  // Offline: the change waits in the replica and the normal background push
  // uploads it (with the same conflict check) on reconnect.
  let pushed = false;
  let pushError: string | null = null;
  if (holdForPublish) {
    hold.addMigrationToHold({
      localPath: source.dbPath,
      dbId: source.dbId,
      purpose: proposal ? "proposal" : "publish",
      migration: { migrationId, sql, breaking, migrationRoot },
    });
    if (proposal) {
      console.log(
        `[TursoReplica] ${migrationId}: team shared data — applied on this desktop only; ` +
          "the cloud copy changes when the publisher approves the proposal",
      );
      pushError = "held for proposal";
    } else {
      console.log(
        `[TursoReplica] ${migrationId}: ${breaking ? "breaking" : "queued behind a breaking"} migration ` +
          "held for publish (applied locally; cloud gets it with the app code)",
      );
      pushError = "held for publish";
    }
  } else if (online) {
    const push = await pushLinkedDbViaTursoReplica(source);
    pushed = push.ok;
    pushError = push.ok ? null : (push.error ?? "replica push failed");
    if (pushed) {
      // Sync does not carry triggers/views to the cloud — copy them over.
      const { mirrorSchemaObjectsToCloud } = await import("./tursoReplicaSchemaObjectMirror.js");
      const mirror = await mirrorSchemaObjectsToCloud({
        source,
        statements: splitSqlStatements(sql),
      });
      if (mirror.error) {
        console.warn(`[TursoReplica] ${migrationId}: triggers/views not copied to the cloud: ${mirror.error}`);
      }
      if (mirror.notCopied.length) {
        console.warn(
          `[TursoReplica] ${migrationId}: trigger(s) ${mirror.notCopied.join(", ")} kept on this desktop only — ` +
            "they write rows with plain INSERT (or x = x + …), which would run twice on the cloud copy. " +
            "Use INSERT OR IGNORE with a deterministic key to make them safe to copy.",
        );
      }
      if (!mirror.error && (mirror.created.length || mirror.dropped.length)) {
        console.log(
          `[TursoReplica] ${migrationId}: copied to the cloud: ${[...mirror.created, ...mirror.dropped.map((d) => `drop ${d}`)].join(", ")}`,
        );
      }
    }
  }

  let paired = false;
  if (pushed) {
    const marked = await markMigrationCloudApplied({
      migrationRoot,
      migrationId,
      applyToken: pair.applyToken,
    });
    paired = marked.pairedAt !== null;
  }

  return {
    applied,
    migrationId,
    applyToken: pair.applyToken,
    replicaApplied: true,
    cloudApplied: pushed,
    paired,
    pushed,
    pushError,
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
