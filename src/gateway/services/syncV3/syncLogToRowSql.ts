/**
 * Convert local _papr_sync_log CDC entries into parameterized row writes for workspace log.
 */

import type Database from "better-sqlite3";
import { quoteIdent, readTableSchema } from "../tursoSyncBridgeCore.js";
import {
  buildPkWhereClause,
  compactSyncLogEntries,
  readSyncLogSince,
  type SyncLogEntry,
} from "../tursoSyncLog.js";
import { WORKSPACE_LOG_SHIP_BATCH_SIZE } from "./WorkspaceLogClient.js";

/** Changelog rows read per ship round (loop until exhausted). */
export const SYNC_LOG_SHIP_READ_LIMIT = WORKSPACE_LOG_SHIP_BATCH_SIZE;

export interface SyncLogShipBatch {
  writes: RowWriteFromSyncLog[];
  /** Highest sync log id consumed this round — advance even when writes is empty. */
  highWaterLogId: number;
  /** True when the raw read hit the limit — more entries may remain. */
  hasMore: boolean;
}

export interface RowWriteFromSyncLog {
  sql: string;
  params: unknown[];
  syncLogId: number;
}

function fetchLocalRowValues(
  db: Database.Database,
  tableName: string,
  rowPk: unknown[],
): unknown[] | null {
  const columns = readTableSchema(db, tableName);
  if (columns.length === 0) {
    return null;
  }
  const { sql: whereSql, usePk } = buildPkWhereClause(columns);
  if (!usePk) {
    return null;
  }
  const colList = columns.map((col) => quoteIdent(col.name)).join(", ");
  const row = db
    .prepare(
      `SELECT ${colList} FROM ${quoteIdent(tableName)} WHERE ${whereSql} LIMIT 1`,
    )
    .raw()
    .get(...rowPk) as unknown[] | undefined;
  return row ?? null;
}

export function syncLogEntryToRowWrite(
  db: Database.Database,
  entry: SyncLogEntry,
): RowWriteFromSyncLog | null {
  const columns = readTableSchema(db, entry.tableName);
  if (columns.length === 0) {
    return null;
  }

  if (entry.op === "delete") {
    const { sql: whereSql, usePk } = buildPkWhereClause(columns);
    if (!usePk) {
      return null;
    }
    return {
      syncLogId: entry.id,
      sql: `DELETE FROM ${quoteIdent(entry.tableName)} WHERE ${whereSql}`,
      params: [...entry.rowPk],
    };
  }

  const rowValues = fetchLocalRowValues(db, entry.tableName, entry.rowPk);
  if (!rowValues) {
    const { sql: whereSql, usePk } = buildPkWhereClause(columns);
    if (!usePk) {
      return null;
    }
    return {
      syncLogId: entry.id,
      sql: `DELETE FROM ${quoteIdent(entry.tableName)} WHERE ${whereSql}`,
      params: [...entry.rowPk],
    };
  }

  const colNames = columns.map((col) => quoteIdent(col.name)).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  return {
    syncLogId: entry.id,
    sql:
      `INSERT OR REPLACE INTO ${quoteIdent(entry.tableName)} (${colNames}) ` +
      `VALUES (${placeholders})`,
    params: rowValues,
  };
}

export function readSyncLogShipBatch(
  db: Database.Database,
  afterId: number,
  limit = SYNC_LOG_SHIP_READ_LIMIT,
): SyncLogShipBatch {
  const raw = readSyncLogSince(db, afterId, limit);
  const entries = compactSyncLogEntries(raw);
  if (entries.length === 0) {
    return { writes: [], highWaterLogId: afterId, hasMore: false };
  }

  let highWaterLogId = afterId;
  const writes: RowWriteFromSyncLog[] = [];
  for (const entry of entries) {
    highWaterLogId = Math.max(highWaterLogId, entry.id);
    const write = syncLogEntryToRowWrite(db, entry);
    if (write) {
      writes.push(write);
    }
  }

  return {
    writes,
    highWaterLogId,
    hasMore: raw.length >= limit,
  };
}

export function readRowWritesFromSyncLogSince(
  db: Database.Database,
  afterId: number,
  limit = SYNC_LOG_SHIP_READ_LIMIT,
): RowWriteFromSyncLog[] {
  return readSyncLogShipBatch(db, afterId, limit).writes;
}
