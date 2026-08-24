/**
 * Local-first mini-app DB writes: apply to SQLite immediately, ship to workspace
 * log asynchronously when cloud sync is enabled (via debounced Turso push).
 */

import * as path from "node:path";

import type { AppDataSource } from "../appDataSources.js";
import type { DbQueryPool, WriteResult } from "../DbQueryPool.js";
import type { DbRouter } from "../appRuntime/DbRouter.js";
import { ensureLocalDbChangeLogReady } from "../tursoSyncBridgeCore.js";
import { isCloudSyncEnabled } from "../../utils/cloudSyncEnabled.js";
import { assertReplaySafeRowSql } from "./replaySafeSql.js";

export interface LocalFirstWriteResult extends WriteResult {
  /** True when a debounced workspace-log ship was scheduled after the local write. */
  cloudSyncScheduled: boolean;
}

function syncKeyForSource(source: AppDataSource): string {
  return source.dbId ?? source.jobId ?? path.normalize(source.dbPath);
}

function scheduleWorkspaceLogShip(syncKey: string): void {
  void import("../tursoPushScheduler.js").then(({ scheduleTursoPushForJob }) => {
    scheduleTursoPushForJob(syncKey, "completion", "api_write");
  });
}

/** Row write: local SQLite first; workspace log ship when cloud sync is on. */
export async function writeLinkedDbRowLocalFirst(
  pool: DbQueryPool,
  dbRouter: DbRouter,
  appId: string,
  source: AppDataSource,
  sql: string,
  params?: unknown[],
): Promise<LocalFirstWriteResult> {
  assertReplaySafeRowSql(sql);

  const localStarted = performance.now();
  let result: WriteResult;

  if (isCloudSyncEnabled()) {
    ensureLocalDbChangeLogReady(source.dbPath);
    result = await dbRouter.write(appId, source, sql, params);
    scheduleWorkspaceLogShip(syncKeyForSource(source));
    const localMs = Math.round(performance.now() - localStarted);
    if (localMs > 50) {
      console.log(
        `[LocalFirstDbWrite] app=${appId} source=${source.alias ?? source.jobId} local=${localMs}ms cloudSyncScheduled=true`,
      );
    }
    return { ...result, cloudSyncScheduled: true };
  }

  result = await pool.write(appId, source.dbPath, sql, params);
  return { ...result, cloudSyncScheduled: false };
}

/** Atomic multi-statement write on one linked SQLite file (single transaction). */
export async function writeLinkedDbBatchAtomic(
  pool: DbQueryPool,
  dbRouter: DbRouter,
  appId: string,
  source: AppDataSource,
  statements: ReadonlyArray<{ sql: string; params?: unknown[] }>,
): Promise<{ source: AppDataSource; results: WriteResult[] }> {
  for (const stmt of statements) {
    assertReplaySafeRowSql(stmt.sql);
  }

  const localStarted = performance.now();
  let results: WriteResult[];

  if (isCloudSyncEnabled()) {
    ensureLocalDbChangeLogReady(source.dbPath);
    results = await dbRouter.writeBatch(appId, source, statements);
    scheduleWorkspaceLogShip(syncKeyForSource(source));
    const localMs = Math.round(performance.now() - localStarted);
    if (localMs > 50) {
      console.log(
        `[LocalFirstDbWrite] atomic batch app=${appId} source=${source.alias ?? source.jobId} count=${statements.length} local=${localMs}ms cloudSyncScheduled=true`,
      );
    }
    return { source, results };
  }

  results = await pool.writeBatch(appId, source.dbPath, [...statements]);
  return { source, results };
}

/** Schema bootstrap: local exec first; drift-heal ships schema on next push when cloud sync is on. */
export async function execLinkedDbSchemaLocalFirst(
  pool: DbQueryPool,
  dbRouter: DbRouter,
  appId: string,
  source: AppDataSource,
  sql: string,
): Promise<{ cloudSyncScheduled: boolean }> {
  if (isCloudSyncEnabled()) {
    ensureLocalDbChangeLogReady(source.dbPath);
    await dbRouter.exec(appId, source, sql);
    scheduleWorkspaceLogShip(syncKeyForSource(source));
    return { cloudSyncScheduled: true };
  }

  await pool.exec(appId, source.dbPath, sql);
  return { cloudSyncScheduled: false };
}
