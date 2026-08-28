/**
 * Route linked DB writes through Turso Sync replica when Plan A is enabled.
 */

import type { AppDataSource } from "../appDataSources.js";
import {
  getDatabaseRegistryService,
  resolveTursoDatabaseNameForSource,
  type DatabaseRecord,
} from "../DatabaseRegistryService.js";
import { getTursoReplicaService } from "./TursoReplicaService.js";
import type { TursoReplicaPushResponse, TursoReplicaWriteResult } from "./tursoReplicaTypes.js";
import {
  isTursoReplicaOnline,
  isTursoReplicaSyncFeatureEnabled,
  shouldUseTursoReplicaForDb,
} from "../../utils/tursoReplicaEnabled.js";
import {
  noteTursoReplicaTransportError,
} from "../../utils/tursoReplicaConnectivity.js";
import {
  checkMigrationPushConflict,
  MIGRATION_CONFLICT_CODE,
} from "./tursoReplicaMigrationConflict.js";
import { drainInboundReplicaCdcIfCaughtUp } from "./tursoReplicaInboundDrain.js";
import {
  linkedSourceAsAppDataSource,
  linkedSourceSyncKey,
  resolveLinkedSourcesForTursoPush,
  type TursoLinkedSource,
} from "../tursoLinkedSources.js";
import { ensureTursoSyncBridge } from "../TursoSyncBridge.js";

async function noteReplicaLocalMutation(source: AppDataSource): Promise<void> {
  if (!source.dbId) {
    return;
  }
  const registry = getDatabaseRegistryService();
  await registry.updateReplicaPushState(source.dbId, {
    lastReplicaLocalMutationAt: new Date().toISOString(),
  });
}

async function noteReplicaPushSuccess(source: AppDataSource): Promise<void> {
  if (!source.dbId) {
    return;
  }
  const registry = getDatabaseRegistryService();
  await registry.updateReplicaPushState(source.dbId, {
    lastReplicaPushError: null,
    lastReplicaPushAt: new Date().toISOString(),
  });
}
import type { TursoPushScopedOptions } from "../TursoSyncBridge.js";
import { publishDbChanged } from "../../utils/publishJobRunEvents.js";
import { notifyCloudDbChanged } from "../cloudSync/notifyCloudDbChanged.js";

/** SSE + cloud notify after replica sync reaches Turso primary or local pull completes. */
export function notifyReplicaDbChanged(
  source: AppDataSource,
  options?: { tables?: string[] },
): void {
  const jobId = source.jobId?.trim();
  const dbId = source.dbId?.trim();
  if (!jobId && !dbId) {
    return;
  }

  const tables = options?.tables ?? [];
  publishDbChanged({
    ...(jobId ? { jobId } : {}),
    ...(dbId ? { dbId } : {}),
    tables,
  });
  void notifyCloudDbChanged({
    ...(jobId ? { jobId } : {}),
    ...(dbId ? { dbId } : {}),
    tables,
  });
}

export function resolveRegistryRecordForSource(
  source: AppDataSource,
): DatabaseRecord | undefined {
  const registry = getDatabaseRegistryService();
  if (source.dbId) {
    const byId = registry.getById(source.dbId);
    if (byId) {
      return byId;
    }
  }
  return registry.getByPath(source.dbPath);
}

export function shouldUseTursoReplicaForSource(source: AppDataSource): boolean {
  const record = resolveRegistryRecordForSource(source);
  // Phase 1: registry DBs only — job scratch DBs stay on legacy CDC until cutover.
  if (!record) {
    return false;
  }
  return shouldUseTursoReplicaForDb({
    syncMode: record.syncMode,
  });
}

/** Skip legacy CDC / workspace-log Turso push when Plan A owns this linked source. */
export function shouldSuppressLegacyTursoPush(options: {
  syncKey: string;
  dbPath?: string;
  dbId?: string;
}): boolean {
  if (!isTursoReplicaSyncFeatureEnabled()) {
    return false;
  }
  const registry = getDatabaseRegistryService();
  const record =
    (options.dbId ? registry.getById(options.dbId) : undefined) ??
    (options.dbPath ? registry.getByPath(options.dbPath) : undefined) ??
    registry.getById(options.syncKey);
  if (!record) {
    return false;
  }
  return shouldUseTursoReplicaForDb({ syncMode: record.syncMode });
}

export function shouldSuppressLegacyTursoPushForLinkedSource(
  source: AppDataSource,
): boolean {
  return shouldSuppressLegacyTursoPush({
    syncKey: source.dbId ?? source.dbPath,
    dbPath: source.dbPath,
    dbId: source.dbId,
  });
}

export async function writeLinkedDbViaTursoReplica(
  source: AppDataSource,
  sql: string,
  params?: unknown[],
): Promise<TursoReplicaWriteResult> {
  const tursoDatabase = resolveTursoDatabaseNameForSource(source);
  if (!tursoDatabase) {
    throw new Error(
      `No Turso database mapped for source ${source.alias ?? source.dbPath}`,
    );
  }

  const replica = getTursoReplicaService();
  const result = await replica.runWrite({
    localPath: source.dbPath,
    tursoDatabase,
    sql,
    params,
  });
  await noteReplicaLocalMutation(source);
  if (!result.pendingPush) {
    await noteReplicaPushSuccess(source);
    notifyReplicaDbChanged(source);
  }
  return result;
}

export async function writeLinkedDbBatchViaTursoReplica(
  source: AppDataSource,
  statements: ReadonlyArray<{ sql: string; params?: unknown[] }>,
): Promise<TursoReplicaWriteResult> {
  const tursoDatabase = resolveTursoDatabaseNameForSource(source);
  if (!tursoDatabase) {
    throw new Error(
      `No Turso database mapped for source ${source.alias ?? source.dbPath}`,
    );
  }

  const replica = getTursoReplicaService();
  const result = await replica.runStatements({
    localPath: source.dbPath,
    tursoDatabase,
    statements,
  });
  await noteReplicaLocalMutation(source);
  if (!result.pendingPush) {
    await noteReplicaPushSuccess(source);
    notifyReplicaDbChanged(source);
  }
  return result;
}

export async function execLinkedDbViaTursoReplica(
  source: AppDataSource,
  sql: string,
): Promise<{ pendingPush: boolean }> {
  const tursoDatabase = resolveTursoDatabaseNameForSource(source);
  if (!tursoDatabase) {
    throw new Error(
      `No Turso database mapped for source ${source.alias ?? source.dbPath}`,
    );
  }

  const replica = getTursoReplicaService();
  const result = await replica.runExec(source.dbPath, tursoDatabase, sql);
  await noteReplicaLocalMutation(source);
  if (!result.pendingPush) {
    await noteReplicaPushSuccess(source);
    notifyReplicaDbChanged(source);
  }
  return result;
}

export async function pullLinkedDbViaTursoReplica(
  source: AppDataSource,
): Promise<boolean> {
  const tursoDatabase = resolveTursoDatabaseNameForSource(source);
  if (!tursoDatabase) {
    throw new Error(
      `No Turso database mapped for source ${source.alias ?? source.dbPath}`,
    );
  }

  const replica = getTursoReplicaService();
  const pulled = await replica.pull(source.dbPath, tursoDatabase);
  if (isTursoReplicaOnline()) {
    await drainInboundReplicaCdcIfCaughtUp({ source, tursoDatabase });
  }
  if (pulled) {
    notifyReplicaDbChanged(source);
  }
  return pulled;
}

export async function pushLinkedDbViaTursoReplica(
  source: AppDataSource,
  options?: { pullBeforePush?: boolean; skipMigrationConflictCheck?: boolean },
): Promise<TursoReplicaPushResponse> {
  const tursoDatabase = resolveTursoDatabaseNameForSource(source);
  if (!tursoDatabase) {
    throw new Error(
      `No Turso database mapped for source ${source.alias ?? source.dbPath}`,
    );
  }

  const replica = getTursoReplicaService();
  const pullFirst =
    isTursoReplicaOnline() && options?.pullBeforePush !== false;

  try {
    if (pullFirst) {
      await replica.pull(source.dbPath, tursoDatabase);
    }

    if (isTursoReplicaOnline() && !options?.skipMigrationConflictCheck) {
      const conflict = await checkMigrationPushConflict({
        source,
        tursoDatabase,
      });
      if (conflict) {
        if (source.dbId) {
          const registry = getDatabaseRegistryService();
          await registry.updateReplicaPushState(source.dbId, {
            lastReplicaPushError: conflict.message,
          });
        }
        return {
          ok: false,
          error: conflict.message,
          conflictCode: MIGRATION_CONFLICT_CODE,
          localOnlyMigrationIds: conflict.localOnlyIds,
          cloudAheadMigrationIds: conflict.cloudAheadIds,
        };
      }
    }

    const result = await replica.push(source.dbPath, tursoDatabase, {
      pullBeforePush: false,
    });

    if (result.ok) {
      notifyReplicaDbChanged(source);
      await drainInboundReplicaCdcIfCaughtUp({ source, tursoDatabase });
      await noteReplicaPushSuccess(source);
    } else if (!result.ok && source.dbId) {
      const registry = getDatabaseRegistryService();
      await registry.updateReplicaPushState(source.dbId, {
        lastReplicaPushError: result.error,
      });
    }

    return result;
  } catch (error) {
    noteTursoReplicaTransportError(error);
    throw error;
  }
}

export async function queryLinkedDbViaTursoReplica(
  source: AppDataSource,
  sql: string,
  params?: unknown[],
  options?: { pullBeforeRead?: boolean },
): Promise<import("../DbQueryPool.js").QueryResult> {
  const tursoDatabase = resolveTursoDatabaseNameForSource(source);
  if (!tursoDatabase) {
    throw new Error(
      `No Turso database mapped for source ${source.alias ?? source.dbPath}`,
    );
  }

  const replica = getTursoReplicaService();
  return replica.runQuery({
    localPath: source.dbPath,
    tursoDatabase,
    sql,
    params,
    pullBeforeRead: options?.pullBeforeRead,
  });
}

export async function schemaLinkedDbViaTursoReplica(
  source: AppDataSource,
): Promise<import("../DbQueryPool.js").SchemaResult> {
  const tursoDatabase = resolveTursoDatabaseNameForSource(source);
  if (!tursoDatabase) {
    throw new Error(
      `No Turso database mapped for source ${source.alias ?? source.dbPath}`,
    );
  }

  const replica = getTursoReplicaService();
  return replica.runSchema(source.dbPath, tursoDatabase);
}

export async function syncStatusForLinkedDb(
  source: AppDataSource,
): Promise<import("./tursoReplicaTypes.js").TursoReplicaSyncStatus> {
  const tursoDatabase = resolveTursoDatabaseNameForSource(source);
  if (!tursoDatabase) {
    throw new Error(
      `No Turso database mapped for source ${source.alias ?? source.dbPath}`,
    );
  }

  const record = resolveRegistryRecordForSource(source);
  const replica = getTursoReplicaService();
  return replica.syncStatus({
    localPath: source.dbPath,
    tursoDatabase,
    syncMode: record?.syncMode,
    cutoverBlocked: record?.cutoverBlocked,
    cutoverBlockReason: record?.cutoverBlockReason ?? null,
    lastPushError: record?.lastReplicaPushError ?? null,
    lastReplicaPushAt: record?.lastReplicaPushAt ?? null,
    lastReplicaLocalMutationAt: record?.lastReplicaLocalMutationAt ?? null,
    source,
  });
}

export interface TursoLinkedSourcePushResult {
  syncKey: string;
  alias: string;
  appId: string;
  backend: "replica" | "legacy";
  ok: boolean;
  error?: string;
}

export async function shouldSkipTursoPushInFlushForReplicaSource(
  source: TursoLinkedSource,
): Promise<boolean> {
  const appSource = linkedSourceAsAppDataSource(source);
  if (!shouldUseTursoReplicaForSource(appSource)) {
    return false;
  }
  if (!isTursoReplicaOnline()) {
    return false;
  }
  try {
    const status = await syncStatusForLinkedDb(appSource);
    return (
      !status.pendingPush &&
      !status.lastPushError &&
      !status.migrationConflict &&
      !status.cutoverBlocked
    );
  } catch {
    return false;
  }
}

export async function pushLinkedSourceWithReplicaRouting(
  source: TursoLinkedSource,
  options?: { tableNames?: string[] },
): Promise<TursoLinkedSourcePushResult> {
  const syncKey = linkedSourceSyncKey(source);
  const appSource = linkedSourceAsAppDataSource(source);

  if (shouldUseTursoReplicaForSource(appSource)) {
    const result = await pushLinkedDbViaTursoReplica(appSource);
    return {
      syncKey,
      alias: source.alias,
      appId: source.appId,
      backend: "replica",
      ok: result.ok,
      error: result.ok ? undefined : result.error,
    };
  }

  const bridge = ensureTursoSyncBridge();
  const pushResult = await bridge.pushJob(syncKey, undefined, {
    tableNames: options?.tableNames,
  });
  if (pushResult.status === "failed") {
    return {
      syncKey,
      alias: source.alias,
      appId: source.appId,
      backend: "legacy",
      ok: false,
      error: pushResult.error ?? "Turso push failed",
    };
  }
  return {
    syncKey,
    alias: source.alias,
    appId: source.appId,
    backend: "legacy",
    ok: true,
  };
}

export async function pushTursoSourcesWithReplicaRouting(options: {
  sources: readonly TursoLinkedSource[];
  scope?: TursoPushScopedOptions;
}): Promise<{
  pushed: number;
  failed: number;
  results: TursoLinkedSourcePushResult[];
}> {
  const allSources = options.sources;
  const explicitTargets = options.scope
    ? resolveLinkedSourcesForTursoPush(allSources, options.scope)
    : allSources;

  const results: TursoLinkedSourcePushResult[] = [];
  let pushed = 0;
  let failed = 0;

  for (const source of explicitTargets) {
    const result = await pushLinkedSourceWithReplicaRouting(source);
    results.push(result);
    if (result.ok) {
      pushed += 1;
    } else {
      failed += 1;
    }
  }

  return { pushed, failed, results };
}
