/**
 * Sync V3 row sync — workspace log replaces fingerprint Turso CDC push/pull.
 *
 * Local _papr_sync_log → POST workspace/log/append → memory applies to Turso
 * Other devices → GET workspace/log/since → materialize to local SQLite
 */

import Database from "better-sqlite3";
import {
  canPerformWorkspaceDbWrite,
  getWorkspaceWriteGeneration,
} from "../workspaceWriteGuard.js";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import {
  ensureLocalDbChangeLogReady,
  isSqliteBusyError,
  isTursoLocalDatabaseCorruptError,
  type PushResult,
  type PullResult,
  type TursoCredentials,
} from "../tursoSyncBridgeCore.js";
import {
  linkedSourceAlternateKeys,
  linkedSourceSyncKey,
  type TursoLinkedSource,
} from "../tursoLinkedSources.js";
import { resolveTursoDatabaseNameForSource } from "../DatabaseRegistryService.js";
import type { AppDataSource } from "../appDataSources.js";
import {
  loadTursoSyncState,
  recordTursoPushSuccess,
  resolveTursoPushStateEntry,
} from "../tursoSyncState.js";
import {
  appendWorkspaceLogBatch,
  WORKSPACE_LOG_SHIP_BATCH_SIZE,
} from "./WorkspaceLogClient.js";
import {
  buildWorkspaceLogRowBatchEntries,
  chunkSyncLogWrites,
} from "./workspaceLogBatchShip.js";
import { yieldEventLoop } from "../cloudSync/yieldEventLoop.js";
import {
  materializeWorkspaceLogSince,
} from "./LogMaterializer.js";
import { getDbPool } from "../DbQueryPool.js";
import { readSyncLogShipBatch } from "./syncLogToRowSql.js";
import { incrementSyncV3Metric } from "./syncV3Metrics.js";
import { ensureWorkspaceLogGenesisForDb } from "./workspaceLogGenesisCutover.js";
import { isLegacyWorkspaceRowSyncEnabled } from "../../utils/tursoReplicaEnabled.js";
import { runSchemaDriftHeal } from "./schemaDriftHeal.js";
import { isSyncV3SchemaLogEnabled } from "./syncV3Flags.js";

export interface WorkspaceLogPushOptions {
  force?: boolean;
  tableNames?: string[];
}

/** Safety cap — 500 rounds × 500 rows ≈ 250k changelog entries per push call. */
const MAX_SYNC_LOG_SHIP_ROUNDS = 500;

function linkedSourceAsAppDataSource(linked: TursoLinkedSource): AppDataSource {
  return {
    id: linked.alias,
    type: "sqlite",
    alias: linked.alias,
    dbPath: linked.dbPath,
    tables: [],
    linkedAt: "",
    ...(linked.jobId ? { jobId: linked.jobId } : {}),
    ...(linked.dbId ? { dbId: linked.dbId } : {}),
    ...(linked.role ? { role: linked.role } : {}),
    ...(linked.writeAuthority ? { writeAuthority: linked.writeAuthority } : {}),
  };
}

/** Registry-aware Turso short name (respects tursoShortName, not raw dbId). */
export function resolveReplicaIdForLinkedSource(
  linked: TursoLinkedSource,
): string | null {
  return resolveTursoDatabaseNameForSource(linkedSourceAsAppDataSource(linked));
}

export async function catchUpLinkedSourceFromWorkspaceLog(
  linked: TursoLinkedSource,
): Promise<number> {
  if (!isLegacyWorkspaceRowSyncEnabled()) {
    return 0;
  }

  const source = linkedSourceAsAppDataSource(linked);
  const { shouldSuppressLegacyTursoPushForLinkedSource } = await import(
    "../tursoReplica/tursoReplicaRouting.js"
  );
  if (shouldSuppressLegacyTursoPushForLinkedSource(source)) {
    return 0;
  }

  const replicaId = resolveReplicaIdForLinkedSource(linked);
  if (!replicaId) {
    return 0;
  }
  const pool = getDbPool();
  return materializeWorkspaceLogSince(
    pool,
    replicaId,
    linkedSourceAsAppDataSource(linked),
  );
}

export async function shipLinkedSourceToWorkspaceLog(
  linked: TursoLinkedSource,
  options?: WorkspaceLogPushOptions,
): Promise<{ shipped: number; lastSyncLogId: number }> {
  if (!isLegacyWorkspaceRowSyncEnabled()) {
    return { shipped: 0, lastSyncLogId: 0 };
  }

  const source = linkedSourceAsAppDataSource(linked);
  const { shouldSuppressLegacyTursoPushForLinkedSource } = await import(
    "../tursoReplica/tursoReplicaRouting.js"
  );
  if (shouldSuppressLegacyTursoPushForLinkedSource(source)) {
    return { shipped: 0, lastSyncLogId: 0 };
  }

  const dbPath = linked.dbPath;
  const syncKey = linkedSourceSyncKey(linked);
  const writeGeneration = getWorkspaceWriteGeneration();
  if (
    !canPerformWorkspaceDbWrite(
      writeGeneration,
      dbPath,
      `workspace log ship ${syncKey}`,
    )
  ) {
    return { shipped: 0, lastSyncLogId: 0 };
  }

  const replicaId = resolveReplicaIdForLinkedSource(linked);
  if (!replicaId || !linked.appId) {
    return { shipped: 0, lastSyncLogId: 0 };
  }

  await ensureWorkspaceLogGenesisForDb(
    replicaId,
    dbPath,
    linked.alias ?? linked.jobId,
  );

  const alternateKeys = linkedSourceAlternateKeys(linked);
  const state = loadTursoSyncState();
  const prev = resolveTursoPushStateEntry(syncKey, dbPath, state, alternateKeys);
  const afterId = options?.force ? 0 : (prev?.lastPushedLogId ?? 0);

  let db: Database.Database | undefined;
  try {
    ensureLocalDbChangeLogReady(dbPath);
    db = new Database(dbPath, { readonly: true, fileMustExist: true });

    let cursor = afterId;
    let shipped = 0;
    let lastSyncLogId = afterId;
    const dbSourceId = linked.alias ?? linked.jobId;
    const shipStarted = performance.now();
    let rounds = 0;

    while (rounds < MAX_SYNC_LOG_SHIP_ROUNDS) {
      rounds += 1;
      const batch = readSyncLogShipBatch(db, cursor);
      if (batch.highWaterLogId <= cursor && batch.writes.length === 0) {
        break;
      }

      if (batch.writes.length > 0) {
        const apiBatches = chunkSyncLogWrites(
          batch.writes,
          WORKSPACE_LOG_SHIP_BATCH_SIZE,
        );
        for (const apiBatch of apiBatches) {
          await appendWorkspaceLogBatch({
            replicaId,
            entries: buildWorkspaceLogRowBatchEntries(
              apiBatch,
              linked.appId,
              dbSourceId,
            ),
          });
          shipped += apiBatch.length;
          incrementSyncV3Metric("v3_op_count", apiBatch.length);
          await yieldEventLoop();
        }
      }

      if (batch.highWaterLogId > cursor) {
        lastSyncLogId = batch.highWaterLogId;
        cursor = batch.highWaterLogId;
        recordTursoPushSuccess(syncKey, dbPath, getPaprRoot(), lastSyncLogId);
      }

      if (!batch.hasMore) {
        break;
      }
      await yieldEventLoop();
    }

    if (rounds >= MAX_SYNC_LOG_SHIP_ROUNDS) {
      console.warn(
        `[WorkspaceLogSync] Stopped after ${MAX_SYNC_LOG_SHIP_ROUNDS} ship round(s) for ${syncKey} — backlog may remain`,
      );
    }

    if (shipped > 0) {
      const shipMs = Math.round(performance.now() - shipStarted);
      console.log(
        `[WorkspaceLogSync] Confirmed ${shipped} row op(s) appended for ${syncKey} in ${shipMs}ms (${rounds} round(s), lastSyncLogId=${lastSyncLogId})`,
      );
    }

    return { shipped, lastSyncLogId };
  } catch (error) {
    if (isSqliteBusyError(error)) {
      console.warn(
        `[WorkspaceLogSync] DB busy, deferring ship for ${syncKey}`,
      );
      return { shipped: 0, lastSyncLogId: afterId };
    }
    if (isTursoLocalDatabaseCorruptError((error as Error).message)) {
      throw error;
    }
    throw error;
  } finally {
    db?.close();
  }
}

/** Push local CDC → workspace log (schema + rows); pull is separate. */
export async function pushLinkedSourceViaWorkspaceLog(
  linked: TursoLinkedSource,
  _credentials?: TursoCredentials,
  options?: WorkspaceLogPushOptions,
): Promise<PushResult> {
  if (!isLegacyWorkspaceRowSyncEnabled()) {
    return {
      status: "skipped",
      tables: [],
      reason: "legacy_row_sync_disabled",
    };
  }

  const syncKey = linkedSourceSyncKey(linked);
  const source = linkedSourceAsAppDataSource(linked);
  const { shouldSuppressLegacyTursoPushForLinkedSource } = await import(
    "../tursoReplica/tursoReplicaRouting.js"
  );
  if (shouldSuppressLegacyTursoPushForLinkedSource(source)) {
    return {
      status: "skipped",
      tables: [],
      reason: "replica_managed",
    };
  }

  try {
    let schemaShipped = 0;
    if (isSyncV3SchemaLogEnabled()) {
      schemaShipped = await runSchemaDriftHeal(linked);
      if (schemaShipped > 0) {
        console.log(
          `[WorkspaceLogSync] Shipped ${schemaShipped} schema migration(s) for ${syncKey}`,
        );
      }
    }

    const rowResult = await shipLinkedSourceToWorkspaceLog(linked, options);
    if (schemaShipped === 0 && rowResult.shipped === 0) {
      return {
        status: "skipped",
        tables: [],
        reason: "all_tables_unchanged",
        lastPushedLogId: rowResult.lastSyncLogId,
      };
    }
    if (schemaShipped > 0 || rowResult.shipped > 0) {
      console.log(
        `[WorkspaceLogSync] Shipped schema=${schemaShipped} row=${rowResult.shipped} for ${syncKey}`,
      );
    }
    return {
      status: "pushed",
      tables: ["*"],
      lastPushedLogId: rowResult.lastSyncLogId,
    };
  } catch (error) {
    return {
      status: "failed",
      tables: [],
      error: (error as Error).message.slice(0, 300),
    };
  }
}

export async function pullLinkedSourceViaWorkspaceLog(
  linked: TursoLinkedSource,
): Promise<PullResult> {
  if (!isLegacyWorkspaceRowSyncEnabled()) {
    return { status: "skipped", reason: "legacy_row_sync_disabled" };
  }

  const syncKey = linkedSourceSyncKey(linked);
  try {
    const applied = await catchUpLinkedSourceFromWorkspaceLog(linked);
    if (applied === 0) {
      return { status: "skipped", reason: "no_remote_changes" };
    }
    console.log(
      `[WorkspaceLogSync] Materialized ${applied} log entry(ies) for ${syncKey}`,
    );
    return { status: "pulled", tables: ["*"] };
  } catch (error) {
    return {
      status: "failed",
      error: (error as Error).message.slice(0, 300),
    };
  }
}

export async function catchUpAllLinkedSourcesFromWorkspaceLog(
  appsRootDir: string,
): Promise<number> {
  if (!isLegacyWorkspaceRowSyncEnabled()) {
    return 0;
  }

  const { discoverTursoLinkedSources, dedupeLinkedSourcesBySyncKey } = await import("../tursoLinkedSources.js");
  const sources = dedupeLinkedSourcesBySyncKey(
    await discoverTursoLinkedSources(appsRootDir),
  );
  let total = 0;
  for (const source of sources) {
    total += await catchUpLinkedSourceFromWorkspaceLog(source);
  }
  return total;
}
