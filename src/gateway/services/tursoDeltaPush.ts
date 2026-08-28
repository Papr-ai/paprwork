/**
 * Batched delta push: apply _papr_sync_log entries to Turso with chunked UPSERT/DELETE.
 */

import type { Client, InArgs } from "@libsql/client";
import type Database from "better-sqlite3";
import {
  quoteIdent,
  readLocalForeignKeyRefs,
  readRemoteTableSchema,
  sortTableNamesForDelete,
  sortTableNamesForInsert,
  type TableColumn,
} from "./tursoSyncBridgeCore.js";
import {
  batchInsertLocalTableRows,
  deleteRemoteRowsByPks,
  fetchRemoteRowsBySinglePk,
  REMOTE_DELETE_PK_CHUNK,
  REMOTE_INSERT_CHUNK_ROWS,
  syncValueCacheKey,
} from "./tursoBulkInsert.js";
import { shouldApplyIncomingRow } from "./rowSyncColumns.js";
import {
  buildPkWhereClause,
  compactSyncLogEntries,
  type SyncLogEntry,
} from "./tursoSyncLog.js";
import { prepareRemoteTableForSync } from "./tursoTablePrep.js";

function fetchLocalRowByPk(
  db: Database.Database,
  tableName: string,
  columns: TableColumn[],
  rowPk: unknown[],
): unknown[] | null {
  const { sql: whereSql, usePk } = buildPkWhereClause(columns);
  if (!usePk) {
    return null;
  }
  const colList = columns.map((col) => quoteIdent(col.name)).join(", ");
  const row = db
    .prepare(`SELECT ${colList} FROM ${quoteIdent(tableName)} WHERE ${whereSql} LIMIT 1`)
    .raw()
    .get(...rowPk) as unknown[] | undefined;
  return row ?? null;
}

async function fetchRemoteRowByPk(
  remote: Client,
  tableName: string,
  localColumns: TableColumn[],
  rowPk: unknown[],
): Promise<unknown[] | null> {
  const remoteColumns = await readRemoteTableSchema(remote, tableName);
  if (remoteColumns.length === 0) {
    return null;
  }
  const pkColumns = remoteColumns.some((col) => col.primaryKey)
    ? remoteColumns
    : localColumns;
  const { sql: whereSql, usePk } = buildPkWhereClause(pkColumns);
  if (!usePk) {
    return null;
  }
  const colList = remoteColumns.map((col) => quoteIdent(col.name)).join(", ");
  const result = await remote.execute({
    sql: `SELECT ${colList} FROM ${quoteIdent(tableName)} WHERE ${whereSql} LIMIT 1`,
    args: rowPk as InArgs,
  });
  if (result.rows.length === 0) {
    return null;
  }
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return localColumns.map((col) => row[col.name] ?? null);
}

async function deleteRemoteRowByPk(
  remote: Client,
  tableName: string,
  columns: TableColumn[],
  rowPk: unknown[],
): Promise<void> {
  const { sql: whereSql, usePk } = buildPkWhereClause(columns);
  if (!usePk) {
    return;
  }
  await remote.execute({
    sql: `DELETE FROM ${quoteIdent(tableName)} WHERE ${whereSql}`,
    args: rowPk as InArgs,
  });
}

interface ResolvedDeltaEntry {
  rowPk: unknown[];
  row: unknown[];
}

function groupEntriesByTable(
  entries: readonly SyncLogEntry[],
): Map<string, SyncLogEntry[]> {
  const byTable = new Map<string, SyncLogEntry[]>();
  for (const entry of entries) {
    const list = byTable.get(entry.tableName) ?? [];
    list.push(entry);
    byTable.set(entry.tableName, list);
  }
  return byTable;
}

function resolveTableEntries(
  localDb: Database.Database,
  tableName: string,
  columns: TableColumn[],
  entries: readonly SyncLogEntry[],
): { deletes: SyncLogEntry[]; upserts: ResolvedDeltaEntry[] } {
  const deletes: SyncLogEntry[] = [];
  const upserts: ResolvedDeltaEntry[] = [];

  for (const entry of entries) {
    if (entry.op === "delete") {
      deletes.push(entry);
      continue;
    }
    const row = fetchLocalRowByPk(localDb, tableName, columns, entry.rowPk);
    if (!row) {
      deletes.push(entry);
    } else {
      upserts.push({ rowPk: entry.rowPk, row });
    }
  }

  return { deletes, upserts };
}

async function batchDeleteRemoteRows(
  remote: Client,
  tableName: string,
  columns: TableColumn[],
  deleteEntries: readonly SyncLogEntry[],
): Promise<void> {
  if (deleteEntries.length === 0) {
    return;
  }

  const pkCols = columns.filter((col) => col.primaryKey);
  const singlePkCol = pkCols.length === 1 ? pkCols[0]!.name : null;

  if (singlePkCol) {
    const pks = deleteEntries
      .map((entry) => entry.rowPk[0])
      .filter((pk): pk is unknown => pk !== undefined);
    for (let offset = 0; offset < pks.length; offset += REMOTE_DELETE_PK_CHUNK) {
      const chunk = pks.slice(offset, offset + REMOTE_DELETE_PK_CHUNK);
      await deleteRemoteRowsByPks(remote, tableName, singlePkCol, chunk);
    }
    return;
  }

  for (const entry of deleteEntries) {
    await deleteRemoteRowByPk(remote, tableName, columns, entry.rowPk);
  }
}

async function batchUpsertRemoteRows(
  remote: Client,
  tableName: string,
  columns: TableColumn[],
  upserts: readonly ResolvedDeltaEntry[],
): Promise<void> {
  if (upserts.length === 0) {
    return;
  }

  const pkCols = columns.filter((col) => col.primaryKey);
  const singlePkCol = pkCols.length === 1 ? pkCols[0]!.name : null;

  if (singlePkCol) {
    const rowsToWrite: unknown[][] = [];
    for (let offset = 0; offset < upserts.length; offset += REMOTE_INSERT_CHUNK_ROWS) {
      const chunk = upserts.slice(offset, offset + REMOTE_INSERT_CHUNK_ROWS);
      const pks = chunk
        .map((entry) => entry.rowPk[0])
        .filter((pk): pk is unknown => pk !== undefined);
      const remoteByPk = await fetchRemoteRowsBySinglePk(
        remote,
        tableName,
        columns,
        singlePkCol,
        pks,
      );
      for (const entry of chunk) {
        const key = syncValueCacheKey(entry.rowPk[0]);
        const existing = key ? remoteByPk.get(key) ?? null : null;
        if (shouldApplyIncomingRow(columns, existing, entry.row)) {
          rowsToWrite.push(entry.row);
        }
      }
    }
    await batchInsertLocalTableRows(remote, tableName, columns, rowsToWrite, "upsert");
    return;
  }

  const rowsToWrite: unknown[][] = [];
  for (const entry of upserts) {
    const existing = await fetchRemoteRowByPk(remote, tableName, columns, entry.rowPk);
    if (shouldApplyIncomingRow(columns, existing, entry.row)) {
      rowsToWrite.push(entry.row);
    }
  }
  await batchInsertLocalTableRows(remote, tableName, columns, rowsToWrite, "upsert");
}

interface TableDeltaWork {
  columns: TableColumn[];
  deletes: SyncLogEntry[];
  upserts: ResolvedDeltaEntry[];
}

/** Push changelog entries from local → Turso. Returns touched table names. */
export async function pushDeltaToRemote(
  localDb: Database.Database,
  remote: Client,
  entries: readonly SyncLogEntry[],
): Promise<string[]> {
  const compacted = compactSyncLogEntries(entries);
  const touched = new Set<string>();
  const workByTable = new Map<string, TableDeltaWork>();

  for (const [tableName, tableEntries] of groupEntriesByTable(compacted)) {
    const columns = await prepareRemoteTableForSync(remote, localDb, tableName);
    if (columns.length === 0) {
      continue;
    }

    const { deletes, upserts } = resolveTableEntries(
      localDb,
      tableName,
      columns,
      tableEntries,
    );
    if (deletes.length === 0 && upserts.length === 0) {
      continue;
    }
    workByTable.set(tableName, { columns, deletes, upserts });
  }

  if (workByTable.size === 0) {
    return [];
  }

  const tableNames = [...workByTable.keys()];
  const foreignKeyRefs = readLocalForeignKeyRefs(localDb, tableNames);

  for (const tableName of sortTableNamesForDelete(tableNames, foreignKeyRefs)) {
    const work = workByTable.get(tableName);
    if (!work || work.deletes.length === 0) {
      continue;
    }
    await batchDeleteRemoteRows(remote, tableName, work.columns, work.deletes);
    touched.add(tableName);
  }

  for (const tableName of sortTableNamesForInsert(tableNames, foreignKeyRefs)) {
    const work = workByTable.get(tableName);
    if (!work || work.upserts.length === 0) {
      continue;
    }
    await batchUpsertRemoteRows(
      remote,
      tableName,
      work.columns,
      work.upserts,
    );
    touched.add(tableName);
  }

  return [...touched];
}
