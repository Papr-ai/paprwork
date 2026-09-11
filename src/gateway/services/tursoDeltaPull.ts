/**
 * Batched delta pull: apply remote _papr_sync_log entries to local SQLite.
 */

import type { Client, InArgs } from "@libsql/client";
import type Database from "better-sqlite3";
import {
  quoteIdent,
  readRemoteTableSchema,
  readTableSchema,
  type TableColumn,
} from "./tursoSyncBridgeCore.js";
import {
  fetchRemoteRowsBySinglePk,
  REMOTE_INSERT_CHUNK_ROWS,
  syncValueCacheKey,
} from "./tursoBulkInsert.js";
import {
  batchDeleteLocalRowsBySinglePk,
  batchUpsertLocalRows,
} from "./tursoLocalBulkWrite.js";
import { migrateLocalTableSchema } from "./tursoSchemaMigration.js";
import { isEngineOwnedTableName } from "./appRuntime/engineOwnedTables.js";
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

function deleteLocalRowByPk(
  db: Database.Database,
  tableName: string,
  columns: TableColumn[],
  rowPk: unknown[],
): void {
  const { sql: whereSql, usePk } = buildPkWhereClause(columns);
  if (!usePk) {
    return;
  }
  db.prepare(`DELETE FROM ${quoteIdent(tableName)} WHERE ${whereSql}`).run(...rowPk);
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

async function ensureLocalTableReadyForPull(
  localDb: Database.Database,
  remote: Client,
  tableName: string,
): Promise<TableColumn[]> {
  // The sync engine owns its own bookkeeping tables and creates them with the exact
  // shape it later requires. Reconstructing one here from the remote's table_info
  // loses whatever this generator cannot express, and the engine then aborts the
  // process seeking an index the rebuilt table does not have. Empty means "skip".
  if (isEngineOwnedTableName(tableName)) {
    return [];
  }

  let columns = readTableSchema(localDb, tableName);
  if (columns.length > 0) {
    await migrateLocalTableSchema(localDb, remote, tableName);
    return readTableSchema(localDb, tableName);
  }

  const remoteCols = await remote.execute(
    `PRAGMA table_info(${quoteIdent(tableName)})`,
  );
  columns = remoteCols.rows.map((row) => ({
    name: String(row.name ?? ""),
    type: String(row.type ?? "TEXT"),
    primaryKey: Number(row.pk ?? 0) > 0,
  }));
  if (columns.length === 0) {
    return columns;
  }

  // `pk` is the 1-based position within the key, not a boolean, and the order of a
  // composite key decides its index. Keep it here rather than widening TableColumn.
  const keyColumns = remoteCols.rows
    .map((row) => ({
      name: String(row.name ?? ""),
      position: Number(row.pk ?? 0),
    }))
    .filter((col) => col.position > 0 && col.name)
    .sort((a, b) => a.position - b.position);

  const columnDefs = columns.map((col) => {
    const inlinePk = keyColumns.length === 1 && col.primaryKey ? " PRIMARY KEY" : "";
    return `${quoteIdent(col.name)} ${col.type || "TEXT"}${inlinePk}`;
  });
  // A composite key can only be declared at table level. Previously it was declared
  // nowhere — the inline branch requires exactly one key column, so a two-column key
  // produced a table with no unique index at all, which is what the engine panics on.
  const tableConstraints =
    keyColumns.length > 1
      ? [
          `PRIMARY KEY (${keyColumns
            .map((col) => quoteIdent(col.name))
            .join(", ")})`,
        ]
      : [];

  localDb.exec(
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(tableName)} (` +
      [...columnDefs, ...tableConstraints].join(", ") +
      `)`,
  );
  return readTableSchema(localDb, tableName);
}

async function batchDeleteLocalRows(
  localDb: Database.Database,
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
    batchDeleteLocalRowsBySinglePk(localDb, tableName, singlePkCol, pks);
    return;
  }

  for (const entry of deleteEntries) {
    deleteLocalRowByPk(localDb, tableName, columns, entry.rowPk);
  }
}

async function batchPullUpsertRemoteRows(
  localDb: Database.Database,
  remote: Client,
  tableName: string,
  columns: TableColumn[],
  upsertEntries: readonly SyncLogEntry[],
): Promise<void> {
  if (upsertEntries.length === 0) {
    return;
  }

  const pkCols = columns.filter((col) => col.primaryKey);
  const singlePkCol = pkCols.length === 1 ? pkCols[0]!.name : null;
  const rowsToWrite: unknown[][] = [];
  const missingRemoteDeletes: SyncLogEntry[] = [];

  if (singlePkCol) {
    for (let offset = 0; offset < upsertEntries.length; offset += REMOTE_INSERT_CHUNK_ROWS) {
      const chunk = upsertEntries.slice(offset, offset + REMOTE_INSERT_CHUNK_ROWS);
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
        const incoming = key ? remoteByPk.get(key) : undefined;
        if (!incoming) {
          missingRemoteDeletes.push(entry);
          continue;
        }
        const existing = fetchLocalRowByPk(localDb, tableName, columns, entry.rowPk);
        if (shouldApplyIncomingRow(columns, existing, incoming)) {
          rowsToWrite.push(incoming);
        }
      }
    }
    await batchDeleteLocalRows(localDb, tableName, columns, missingRemoteDeletes);
    batchUpsertLocalRows(localDb, tableName, columns, rowsToWrite);
    return;
  }

  for (const entry of upsertEntries) {
    const incoming = await fetchRemoteRowByPk(remote, tableName, columns, entry.rowPk);
    if (!incoming) {
      deleteLocalRowByPk(localDb, tableName, columns, entry.rowPk);
      continue;
    }
    const existing = fetchLocalRowByPk(localDb, tableName, columns, entry.rowPk);
    if (shouldApplyIncomingRow(columns, existing, incoming)) {
      rowsToWrite.push(incoming);
    }
  }
  batchUpsertLocalRows(localDb, tableName, columns, rowsToWrite);
}

/** Apply remote changelog entries to local SQLite (caller must wrap with withSyncMuted). */
export async function applyRemoteSyncLogToLocal(
  localDb: Database.Database,
  remote: Client,
  entries: readonly SyncLogEntry[],
): Promise<string[]> {
  const compacted = compactSyncLogEntries(entries);
  const touched = new Set<string>();

  for (const [tableName, tableEntries] of groupEntriesByTable(compacted)) {
    let columns = await ensureLocalTableReadyForPull(localDb, remote, tableName);
    if (columns.length === 0) {
      continue;
    }

    columns = await prepareRemoteTableForSync(remote, localDb, tableName);

    const deletes = tableEntries.filter((entry) => entry.op === "delete");
    const upserts = tableEntries.filter((entry) => entry.op !== "delete");

    await batchDeleteLocalRows(localDb, tableName, columns, deletes);
    await batchPullUpsertRemoteRows(localDb, remote, tableName, columns, upserts);
    touched.add(tableName);
  }

  return [...touched];
}
