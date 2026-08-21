/**
 * Chunk local CDC row writes into workspace log batch append requests.
 */

import type { WorkspaceLogBatchEntry } from "../../../core/types/workspaceLog.js";
import type { RowWriteFromSyncLog } from "./syncLogToRowSql.js";

export function chunkSyncLogWrites<T>(
  items: T[],
  batchSize: number,
): T[][] {
  if (batchSize < 1) {
    throw new Error("batchSize must be >= 1");
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    chunks.push(items.slice(i, i + batchSize));
  }
  return chunks;
}

export function buildWorkspaceLogRowBatchEntries(
  writes: RowWriteFromSyncLog[],
  appId: string,
  dbSourceId: string | undefined,
): WorkspaceLogBatchEntry[] {
  return writes.map((write) => ({
    kind: "row" as const,
    dbSourceId,
    payload: {
      appId,
      sql: write.sql,
      params: write.params,
    },
  }));
}

export function maxSyncLogIdInBatch(writes: RowWriteFromSyncLog[]): number {
  let maxId = 0;
  for (const write of writes) {
    maxId = Math.max(maxId, write.syncLogId);
  }
  return maxId;
}
