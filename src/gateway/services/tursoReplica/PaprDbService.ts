/**
 * Agent-facing Papr DB operations (Plan A Turso replica path).
 */

import * as path from "path";
import type { AppDataSource } from "../appDataSources.js";
import {
  getDatabaseRegistryService,
  initializeDatabaseRegistry,
  tursoNameForRecord,
} from "../DatabaseRegistryService.js";
import {
  applyDatabaseMigrations,
  resolveMigrationRootFromDbPath,
} from "../jobs/databaseMigrations.js";
import { readMigrationSql } from "../jobs/jobMigrationManifest.js";
import {
  isTursoReplicaSyncFeatureEnabled,
} from "../../utils/tursoReplicaEnabled.js";
import {
  pullLinkedDbViaTursoReplica,
  pushLinkedDbViaTursoReplica,
  syncStatusForLinkedDb,
  writeLinkedDbViaTursoReplica,
  execLinkedDbViaTursoReplica,
} from "./tursoReplicaRouting.js";
import {
  applyRegistryMigrationDualPath,
  applyRegistryMigrationOnCloudPrimary,
  applyRegistryMigrationOnReplicaOnly,
  buildMigrationParityReport,
} from "./tursoReplicaMigrationDualApply.js";
import {
  reconcileReplicaSync,
  type ReconcileSyncAction,
} from "./tursoReplicaReconcileSync.js";
import { ensureReplicaSchemaMigrationsLedger } from "./tursoReplicaSchemaLedger.js";
import type { TursoReplicaSyncStatus } from "./tursoReplicaTypes.js";
import {
  assertPaprDbExecAllowed,
  assertPaprDbMigrationApplyAllowed,
  assertReplicaDdlAllowed,
} from "./replicaSchemaPolicy.js";
import { MIGRATION_CONFLICT_CODE, checkMigrationPushConflict } from "./tursoReplicaMigrationConflict.js";
import { rebaseLocalMigrationLedger } from "./tursoReplicaMigrationRebase.js";
import { promises as fsPromises } from "fs";

export interface PaprDbSourceRef {
  dbId?: string;
  localPath?: string;
}

function resolveSource(ref: PaprDbSourceRef): AppDataSource {
  const registry = getDatabaseRegistryService();
  const record = ref.dbId
    ? registry.getById(ref.dbId)
    : ref.localPath
      ? registry.getByPath(ref.localPath)
      : undefined;

  if (!record) {
    throw new Error(
      ref.dbId
        ? `Database not found in registry: ${ref.dbId}`
        : `Database not found at path: ${ref.localPath ?? "(missing)"}`,
    );
  }

  return {
    id: record.dbId,
    type: "sqlite",
    dbId: record.dbId,
    alias: record.label ?? record.dbId,
    dbPath: record.localPath,
    tables: [],
    linkedAt: record.createdAt,
  };
}

async function scheduleLegacyCutoverRetryAfterRepair(dbId: string): Promise<void> {
  try {
    const { retryReplicaCutoverAfterRepair } = await import(
      "./cutover/tursoReplicaCutoverOrchestrator.js"
    );
    await retryReplicaCutoverAfterRepair(dbId);
  } catch (error) {
    console.warn(
      `[PaprDbService] Legacy cutover retry after repair failed for ${dbId}:`,
      (error as Error).message.slice(0, 120),
    );
  }
}

export async function paprDbSyncStatus(
  ref: PaprDbSourceRef,
): Promise<TursoReplicaSyncStatus & { dbId: string; localPath: string }> {
  await initializeDatabaseRegistry();
  const source = resolveSource(ref);
  const status = await syncStatusForLinkedDb(source);
  return {
    ...status,
    dbId: source.dbId ?? source.id,
    localPath: source.dbPath,
  };
}

export async function paprDbPush(
  ref: PaprDbSourceRef,
): Promise<{
  ok: boolean;
  error?: string;
  conflictCode?: string;
  localOnlyMigrationIds?: string[];
  cloudAheadMigrationIds?: string[];
  dbId: string;
}> {
  await initializeDatabaseRegistry();
  const source = resolveSource(ref);
  const result = await pushLinkedDbViaTursoReplica(source);
  return { ...result, dbId: source.dbId ?? source.id };
}

export type RepairCloudSyncStrategy =
  | "pull"
  | "push"
  | "accept_cloud"
  | "merge_lww"
  | "force_local"
  | "bootstrap_remote"
  | "export_conflicts";

export interface MigrationConflictExport {
  code: typeof MIGRATION_CONFLICT_CODE;
  message: string;
  localOnlyMigrationIds: string[];
  remoteOnlyMigrationIds: string[];
  cloudAheadMigrationIds: string[];
}

export async function repairCloudSync(options: {
  dbId: string;
  strategy: RepairCloudSyncStrategy;
}): Promise<{
  strategy: RepairCloudSyncStrategy;
  dbId: string;
  pull?: { pulled: boolean };
  push?: {
    ok: boolean;
    error?: string;
    conflictCode?: string;
    localOnlyMigrationIds?: string[];
    cloudAheadMigrationIds?: string[];
  };
  rebasedMigrationIds?: string[];
  backupPath?: string;
  conflicts?: MigrationConflictExport | null;
  syncStatus?: TursoReplicaSyncStatus & { dbId: string; localPath: string };
}> {
  await initializeDatabaseRegistry();
  const source = resolveSource({ dbId: options.dbId });
  const registry = getDatabaseRegistryService();
  const replica = (
    await import("./TursoReplicaService.js")
  ).getTursoReplicaService();

  switch (options.strategy) {
    case "pull": {
      const pull = await paprDbPull({ dbId: options.dbId });
      const syncStatus = await paprDbSyncStatus({ dbId: options.dbId });
      return {
        strategy: options.strategy,
        dbId: options.dbId,
        pull: { pulled: pull.pulled },
        syncStatus,
      };
    }
    case "accept_cloud": {
      const record = registry.getById(options.dbId);
      if (record?.syncMode === "replica") {
        const { reseedTursoReplicaFromRemote } = await import(
          "./tursoReplicaProvision.js"
        );
        // Close BEFORE reseeding, and again after.
        //
        // Reseeding rewrites data.db and its sidecars on disk, but a cached
        // sync handle keeps its own WAL offset in memory. Without closing, the
        // files come back healthy — papr_db_sync_status reports sidecarWedge
        // false — while every write still fails "short read on WAL frame",
        // because the live handle points into the WAL that was just replaced.
        // That is why this repair only appeared to work after an app restart.
        await replica.close(source.dbPath);
        await reseedTursoReplicaFromRemote(record);
        await replica.close(source.dbPath);
      } else {
        await replica.close(source.dbPath);
        await paprDbPull({ dbId: options.dbId });
      }
      await registry.updateReplicaPushState(options.dbId, {
        lastReplicaPushError: null,
        cutoverBlocked: false,
        cutoverBlockReason: null,
      });
      await scheduleLegacyCutoverRetryAfterRepair(options.dbId);
      const syncStatus = await paprDbSyncStatus({ dbId: options.dbId });
      return {
        strategy: options.strategy,
        dbId: options.dbId,
        pull: { pulled: true },
        syncStatus,
      };
    }
    case "push": {
      const push = await paprDbPush({ dbId: options.dbId });
      if (push.ok) {
        await scheduleLegacyCutoverRetryAfterRepair(options.dbId);
      }
      const syncStatus = await paprDbSyncStatus({ dbId: options.dbId });
      return {
        strategy: options.strategy,
        dbId: options.dbId,
        push: {
          ok: push.ok,
          error: push.error,
          conflictCode: push.conflictCode,
          localOnlyMigrationIds: push.localOnlyMigrationIds,
          cloudAheadMigrationIds: push.cloudAheadMigrationIds,
        },
        syncStatus,
      };
    }
    case "merge_lww": {
      console.warn(
        "[PaprDbService] merge_lww is deprecated for schema recovery — " +
          "use papr_db_migration_parity + papr_db_reconcile_sync instead.",
      );
      await paprDbPull({ dbId: options.dbId });
      let push = await paprDbPush({ dbId: options.dbId });
      let rebasedMigrationIds: string[] | undefined;

      if (
        !push.ok &&
        push.conflictCode === MIGRATION_CONFLICT_CODE &&
        push.cloudAheadMigrationIds &&
        push.cloudAheadMigrationIds.length > 0
      ) {
        rebasedMigrationIds = await rebaseLocalMigrationLedger(
          source,
          push.cloudAheadMigrationIds,
        );
        await paprDbPull({ dbId: options.dbId });
        push = await paprDbPush({ dbId: options.dbId });
      }

      await registry.updateReplicaPushState(options.dbId, {
        lastReplicaPushError: push.ok ? null : (push.error ?? "Push failed"),
        cutoverBlocked: !push.ok,
        cutoverBlockReason: push.ok ? null : (push.error ?? null),
      });

      if (push.ok) {
        await scheduleLegacyCutoverRetryAfterRepair(options.dbId);
      }

      const syncStatus = await paprDbSyncStatus({ dbId: options.dbId });
      return {
        strategy: options.strategy,
        dbId: options.dbId,
        pull: { pulled: true },
        push: {
          ok: push.ok,
          error: push.error,
          conflictCode: push.conflictCode,
          localOnlyMigrationIds: push.localOnlyMigrationIds,
          cloudAheadMigrationIds: push.cloudAheadMigrationIds,
        },
        rebasedMigrationIds,
        syncStatus,
      };
    }
    case "force_local": {
      const record = registry.getById(options.dbId);
      if (!record) {
        throw new Error(`Database not found: ${options.dbId}`);
      }

      const backupPath = `${record.localPath}.force-local-${Date.now()}.bak`;
      try {
        await fsPromises.copyFile(record.localPath, backupPath);
      } catch {
        // Local file may not exist yet — proceed with push attempt
      }

      const pushResult = await pushLinkedDbViaTursoReplica(source, {
        pullBeforePush: false,
        skipMigrationConflictCheck: true,
      });

      await registry.updateReplicaPushState(options.dbId, {
        lastReplicaPushError: pushResult.ok ? null : (pushResult.error ?? "Push failed"),
        cutoverBlocked: !pushResult.ok,
        cutoverBlockReason: pushResult.ok ? null : (pushResult.error ?? null),
      });

      if (pushResult.ok) {
        await scheduleLegacyCutoverRetryAfterRepair(options.dbId);
      }

      const syncStatus = await paprDbSyncStatus({ dbId: options.dbId });
      return {
        strategy: options.strategy,
        dbId: options.dbId,
        backupPath,
        push: pushResult.ok
          ? { ok: true as const }
          : {
              ok: false as const,
              error: pushResult.error,
              conflictCode: pushResult.conflictCode,
              localOnlyMigrationIds: pushResult.localOnlyMigrationIds,
              cloudAheadMigrationIds: pushResult.cloudAheadMigrationIds,
            },
        syncStatus,
      };
    }
    case "bootstrap_remote": {
      const record = registry.getById(options.dbId);
      if (!record) {
        throw new Error(`Database not found: ${options.dbId}`);
      }

      const backupPath = `${record.localPath}.bootstrap-remote-${Date.now()}.bak`;
      try {
        await fsPromises.copyFile(record.localPath, backupPath);
      } catch {
        // Local file may not exist yet — proceed
      }

      const replicaService = (
        await import("./TursoReplicaService.js")
      ).getTursoReplicaService();
      await replicaService.close(record.localPath);

      const { pushLocalLegacyFileToTursoPrimary, reseedTursoReplicaFromRemote } =
        await import("./tursoReplicaProvision.js");
      await pushLocalLegacyFileToTursoPrimary(record);

      if (record.syncMode === "replica") {
        await reseedTursoReplicaFromRemote(record);
      } else {
        await pullLinkedDbViaTursoReplica(source);
      }

      await registry.updateReplicaPushState(options.dbId, {
        lastReplicaPushError: null,
        cutoverBlocked: false,
        cutoverBlockReason: null,
      });
      await scheduleLegacyCutoverRetryAfterRepair(options.dbId);

      const syncStatus = await paprDbSyncStatus({ dbId: options.dbId });
      return {
        strategy: options.strategy,
        dbId: options.dbId,
        backupPath,
        push: { ok: true as const },
        pull: { pulled: true },
        syncStatus,
      };
    }
    case "export_conflicts": {
      const record = registry.getById(options.dbId);
      if (!record) {
        throw new Error(`Database not found: ${options.dbId}`);
      }
      const conflict = await checkMigrationPushConflict({
        source,
        tursoDatabase: tursoNameForRecord(record),
      });
      const syncStatus = await paprDbSyncStatus({ dbId: options.dbId });
      return {
        strategy: options.strategy,
        dbId: options.dbId,
        conflicts: conflict
          ? {
              code: conflict.code,
              message: conflict.message,
              localOnlyMigrationIds: conflict.localOnlyIds,
              remoteOnlyMigrationIds: conflict.remoteOnlyIds,
              cloudAheadMigrationIds: conflict.cloudAheadIds,
            }
          : null,
        syncStatus,
      };
    }
    default: {
      const exhaustive: never = options.strategy;
      throw new Error(`Unknown repair strategy: ${String(exhaustive)}`);
    }
  }
}

export async function paprDbPull(
  ref: PaprDbSourceRef,
): Promise<{ pulled: boolean; dbId: string }> {
  await initializeDatabaseRegistry();
  const source = resolveSource(ref);
  const pulled = await pullLinkedDbViaTursoReplica(source);
  return { pulled, dbId: source.dbId ?? source.id };
}

export async function paprDbExec(options: {
  dbId?: string;
  localPath?: string;
  sql: string;
  params?: unknown[];
}): Promise<{
  changes: number;
  lastInsertRowid: number;
  pendingPush: boolean;
  backend: "turso-replica" | "legacy-local";
}> {
  await initializeDatabaseRegistry();
  const source = resolveSource({
    dbId: options.dbId,
    localPath: options.localPath,
  });

  if (!isTursoReplicaSyncFeatureEnabled()) {
    throw new Error(
      "papr_db_exec requires PAPR_TURSO_REPLICA_SYNC=force or syncMode=replica",
    );
  }

  assertPaprDbExecAllowed(options.sql);

  const trimmed = options.sql.trim().toLowerCase();
  const isDml =
    trimmed.startsWith("insert") ||
    trimmed.startsWith("update") ||
    trimmed.startsWith("delete") ||
    trimmed.startsWith("replace") ||
    trimmed.startsWith("upsert");

  if (isDml) {
    const result = await writeLinkedDbViaTursoReplica(
      source,
      options.sql,
      options.params,
    );
    await clearReplicaPushErrorOnSuccess(source);
    return result;
  }

  assertReplicaDdlAllowed(options.sql);

  const execResult = await execLinkedDbViaTursoReplica(source, options.sql);
  await clearReplicaPushErrorOnSuccess(source);
  return {
    changes: 0,
    lastInsertRowid: 0,
    pendingPush: execResult.pendingPush,
    backend: "turso-replica",
  };
}

async function clearReplicaPushErrorOnSuccess(source: AppDataSource): Promise<void> {
  if (!source.dbId) {
    return;
  }
  const registry = getDatabaseRegistryService();
  await registry.updateReplicaPushState(source.dbId, {
    lastReplicaPushError: null,
  });
}

export async function paprDbApplyMigration(options: {
  dbId: string;
  migrationId: string;
}): Promise<{
  applied: boolean;
  migrationId: string;
  pendingPush: boolean;
  backend: "turso-replica" | "legacy-local";
  applyToken?: string;
  replicaApplied?: boolean;
  cloudApplied?: boolean;
  paired?: boolean;
  pulled?: boolean;
}> {
  await initializeDatabaseRegistry();
  const source = resolveSource({ dbId: options.dbId });
  const migrationRoot = resolveMigrationRootFromDbPath(source.dbPath);
  if (!migrationRoot) {
    throw new Error(`No migrations/ folder for database ${options.dbId}`);
  }

  const migrationFileName = options.migrationId.endsWith(".sql")
    ? options.migrationId
    : `${options.migrationId}.sql`;

  if (!isTursoReplicaSyncFeatureEnabled()) {
    const appliedIds = await applyDatabaseMigrations(migrationRoot, source.dbPath);
    const migrationId = migrationFileName.replace(/\.sql$/, "");
    return {
      applied: appliedIds.includes(migrationId),
      migrationId,
      pendingPush: false,
      backend: "legacy-local",
    };
  }

  const sql = await readMigrationSql(migrationRoot, migrationFileName);
  if (!sql) {
    throw new Error(
      `Migration file not found: ${path.join(migrationRoot, "migrations", migrationFileName)}`,
    );
  }

  await ensureReplicaSchemaMigrationsLedger(source);

  assertPaprDbMigrationApplyAllowed();

  const result = await applyRegistryMigrationDualPath(
    source,
    migrationRoot,
    migrationFileName,
  );
  await clearReplicaPushErrorOnSuccess(source);
  if (result.applied || result.replicaApplied) {
    const { afterRegistryMigrationApplied } = await import(
      "./tursoReplicaPostMigration.js"
    );
    await afterRegistryMigrationApplied({
      dbId: options.dbId,
      migrationId: result.migrationId,
      source,
    });
  }

  return {
    applied: result.applied,
    migrationId: result.migrationId,
    pendingPush: !result.paired && !result.pulled,
    backend: "turso-replica",
    applyToken: result.applyToken,
    replicaApplied: result.replicaApplied,
    cloudApplied: result.cloudApplied,
    paired: result.paired,
    pulled: result.pulled,
  };
}

export async function paprDbApplyMigrationReplica(options: {
  dbId: string;
  migrationId: string;
}): Promise<{
  applied: boolean;
  migrationId: string;
  pendingPush: boolean;
  applyToken: string;
  sqlChecksum: string;
}> {
  await initializeDatabaseRegistry();
  const source = resolveSource({ dbId: options.dbId });
  const migrationRoot = resolveMigrationRootFromDbPath(source.dbPath);
  if (!migrationRoot) {
    throw new Error(`No migrations/ folder for database ${options.dbId}`);
  }
  const migrationFileName = options.migrationId.endsWith(".sql")
    ? options.migrationId
    : `${options.migrationId}.sql`;

  assertPaprDbMigrationApplyAllowed();
  await ensureReplicaSchemaMigrationsLedger(source);

  return applyRegistryMigrationOnReplicaOnly(
    source,
    migrationRoot,
    migrationFileName,
  );
}

export async function paprDbApplyMigrationCloud(options: {
  dbId: string;
  migrationId: string;
  applyToken: string;
}): Promise<{
  applied: boolean;
  migrationId: string;
  paired: boolean;
  applyToken: string;
}> {
  await initializeDatabaseRegistry();
  const source = resolveSource({ dbId: options.dbId });
  const migrationRoot = resolveMigrationRootFromDbPath(source.dbPath);
  if (!migrationRoot) {
    throw new Error(`No migrations/ folder for database ${options.dbId}`);
  }
  const migrationFileName = options.migrationId.endsWith(".sql")
    ? options.migrationId
    : `${options.migrationId}.sql`;

  assertPaprDbMigrationApplyAllowed();

  const result = await applyRegistryMigrationOnCloudPrimary(
    source,
    migrationRoot,
    migrationFileName,
    options.applyToken,
  );
  await clearReplicaPushErrorOnSuccess(source);
  return result;
}

export async function paprDbMigrationParity(options: {
  dbId: string;
}): Promise<Awaited<ReturnType<typeof buildMigrationParityReport>>> {
  await initializeDatabaseRegistry();
  const source = resolveSource({ dbId: options.dbId });
  const migrationRoot = resolveMigrationRootFromDbPath(source.dbPath);
  if (!migrationRoot) {
    throw new Error(`No migrations/ folder for database ${options.dbId}`);
  }
  return buildMigrationParityReport({
    source,
    migrationRoot,
    dbId: options.dbId,
  });
}

export async function paprDbReconcileSync(options: {
  dbId: string;
  action: ReconcileSyncAction;
  applyToken?: string;
  migrationId?: string;
}): Promise<Awaited<ReturnType<typeof reconcileReplicaSync>>> {
  await initializeDatabaseRegistry();
  const source = resolveSource({ dbId: options.dbId });
  const migrationRoot = resolveMigrationRootFromDbPath(source.dbPath);
  if (!migrationRoot) {
    throw new Error(`No migrations/ folder for database ${options.dbId}`);
  }
  return reconcileReplicaSync({
    source,
    dbId: options.dbId,
    migrationRoot,
    action: options.action,
    applyToken: options.applyToken,
    migrationId: options.migrationId,
  });
}
