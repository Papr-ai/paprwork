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
  maxSyncLogIdInBatch,
} from "./workspaceLogBatchShip.js";
import { yieldEventLoop } from "../cloudSync/yieldEventLoop.js";
import {
  materializeWorkspaceLogSince,
} from "./LogMaterializer.js";
import { getDbPool } from "../DbQueryPool.js";
import { readRowWritesFromSyncLogSince } from "./syncLogToRowSql.js";
import { incrementSyncV3Metric } from "./syncV3Metrics.js";
import { ensureWorkspaceLogGenesisForDb } from "./workspaceLogGenesisCutover.js";

export interface WorkspaceLogPushOptions {
  force?: boolean;
  tableNames?: string[];
}

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
    const writes = readRowWritesFromSyncLogSince(db, afterId);
    if (writes.length === 0) {
      return { shipped: 0, lastSyncLogId: afterId };
    }

    let shipped = 0;
    let lastSyncLogId = afterId;
    const dbSourceId = linked.alias ?? linked.jobId;
    const batches = chunkSyncLogWrites(writes, WORKSPACE_LOG_SHIP_BATCH_SIZE);
    const shipStarted = performance.now();
    for (const batch of batches) {
      await appendWorkspaceLogBatch({
        replicaId,
        entries: buildWorkspaceLogRowBatchEntries(
          batch,
          linked.appId,
          dbSourceId,
        ),
      });
      shipped += batch.length;
      lastSyncLogId = Math.max(lastSyncLogId, maxSyncLogIdInBatch(batch));
      incrementSyncV3Metric("v3_op_count", batch.length);
      await yieldEventLoop();
    }

    if (shipped > 0) {
      recordTursoPushSuccess(syncKey, dbPath, getPaprRoot(), lastSyncLogId);
      const shipMs = Math.round(performance.now() - shipStarted);
      console.log(
        `[WorkspaceLogSync] Confirmed ${shipped} row op(s) appended for ${syncKey} in ${shipMs}ms (lastSyncLogId=${lastSyncLogId})`,
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
  const syncKey = linkedSourceSyncKey(linked);
  try {
    const { ensureReplicaReady } = await import("./ensureReplicaReady.js");
    const { schemaShipped, rowsShipped, lastSyncLogId } =
      await ensureReplicaReady(linked, options);
    if (schemaShipped === 0 && rowsShipped === 0) {
      return {
        status: "skipped",
        tables: [],
        reason: "all_tables_unchanged",
        lastPushedLogId: lastSyncLogId,
      };
    }
    if (schemaShipped > 0 || rowsShipped > 0) {
      console.log(
        `[WorkspaceLogSync] Shipped schema=${schemaShipped} row=${rowsShipped} for ${syncKey}`,
      );
    }
    return {
      status: "pushed",
      tables: ["*"],
      lastPushedLogId: lastSyncLogId,
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
  const { discoverTursoLinkedSources } = await import("../tursoLinkedSources.js");
  const sources = await discoverTursoLinkedSources(appsRootDir);
  let total = 0;
  for (const source of sources) {
    total += await catchUpLinkedSourceFromWorkspaceLog(source);
  }
  return total;
}
