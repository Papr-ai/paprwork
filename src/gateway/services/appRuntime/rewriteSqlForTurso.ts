/**
 * Rewrite mini-app SQL for Turso — per-job DBs use the same table names as local SQLite.
 */

import type { AppDataSource } from "../appDataSources.js";
import { isScratchTable } from "../tursoSyncBridgeCore.js";

/**
 * Per-job Turso databases mirror local table names — no rewriting needed.
 */
export function rewriteSqlForTurso(
  sql: string,
  _source: AppDataSource,
  _tableNames: readonly string[],
): string {
  return sql;
}

/** Return table name for schema responses (identity in per-job mode). */
export function displayTableName(remoteName: string, _jobId: string): string | null {
  if (isScratchTable(remoteName)) {
    return null;
  }
  return remoteName;
}
