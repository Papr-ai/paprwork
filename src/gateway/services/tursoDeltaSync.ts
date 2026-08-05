/**
 * Apply changelog entries to local SQLite or remote Turso (delta sync).
 */

import type { Client, InArgs } from "@libsql/client";
import type Database from "better-sqlite3";
import {
  filterSyncableTables,
  quoteIdent,
  readLocalTable,
  readRemoteTableSchema,
  readTableSchema,
  replaceRemoteTable,
  type TableColumn,
} from "./tursoSyncBridgeCore.js";
import {
  migrateLocalTableSchema,
  migrateRemoteTableSchema,
} from "./tursoSchemaMigration.js";
import { fullSchemasMatch, userSchemasMatch } from "./tursoTableFingerprint.js";
import {
  buildPkWhereClause,
  ensureRemoteTableSyncTriggers,
  type SyncLogEntry,
} from "./tursoSyncLog.js";
import {
  ensureLocalRowSyncColumns,
  ensureRemoteRowSyncColumns,
  shouldApplyIncomingRow,
} from "./rowSyncColumns.js";

export async function remoteNeedsBootstrap(remote: Client): Promise<boolean> {
  const result = await remote.execute(
    `SELECT name FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
       AND name NOT LIKE 'libsql_%'
       AND name NOT LIKE '_papr_%'`,
  );
  return result.rows.length === 0;
}

/** User tables currently on remote Turso (excludes infra tables). */
export async function listRemoteUserTables(remote: Client): Promise<string[]> {
  const result = await remote.execute(
    `SELECT name FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
       AND name NOT LIKE 'libsql_%'
       AND name NOT LIKE '_papr_%'`,
  );
  return result.rows.map((row) => String(row.name ?? "")).filter(Boolean);
}

/** Local syncable tables missing from remote — schema drift after partial bootstrap. */
export async function remoteMissingLocalTables(
  remote: Client,
  localTableNames: readonly string[],
): Promise<string[]> {
  const remoteNames = new Set(await listRemoteUserTables(remote));
  return localTableNames.filter((name) => !remoteNames.has(name));
}

/** Remote syncable tables missing from local — partial delta pull on empty sandbox. */
export async function localMissingRemoteTables(
  remote: Client,
  localTableNames: readonly string[],
): Promise<string[]> {
  const remoteNames = filterSyncableTables(await listRemoteUserTables(remote));
  const localNames = new Set(localTableNames);
  return remoteNames.filter((name) => !localNames.has(name));
}

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

async function upsertRemoteRow(
  remote: Client,
  tableName: string,
  columns: TableColumn[],
  row: unknown[],
  rowPk: unknown[],
): Promise<void> {
  const existing = await fetchRemoteRowByPk(remote, tableName, columns, rowPk);
  if (!shouldApplyIncomingRow(columns, existing, row)) {
    return;
  }
  const placeholders = columns.map(() => "?").join(", ");
  const colNames = columns.map((col) => quoteIdent(col.name)).join(", ");
  await remote.execute({
    sql:
      `INSERT OR REPLACE INTO ${quoteIdent(tableName)} (${colNames}) ` +
      `VALUES (${placeholders})`,
    args: row as InArgs,
  });
}

function upsertLocalRow(
  db: Database.Database,
  tableName: string,
  columns: TableColumn[],
  row: unknown[],
  rowPk: unknown[],
): void {
  const existing = fetchLocalRowByPk(db, tableName, columns, rowPk);
  if (!shouldApplyIncomingRow(columns, existing, row)) {
    return;
  }
  const placeholders = columns.map(() => "?").join(", ");
  const colNames = columns.map((col) => quoteIdent(col.name)).join(", ");
  db.prepare(
    `INSERT OR REPLACE INTO ${quoteIdent(tableName)} (${colNames}) VALUES (${placeholders})`,
  ).run(...row);
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

/** Align remote Turso schema with local before push/pull row sync (DDL + _papr_* columns). */
export async function prepareRemoteTableForSync(
  remote: Client,
  localDb: Database.Database,
  tableName: string,
): Promise<TableColumn[]> {
  ensureLocalRowSyncColumns(localDb, tableName);
  let columns = readTableSchema(localDb, tableName);
  if (columns.length === 0) {
    return columns;
  }

  const exists = await remote.execute({
    sql: `SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`,
    args: [tableName],
  });
  if (exists.rows.length === 0) {
    const table = readLocalTable(localDb, tableName);
    await replaceRemoteTable(remote, table);
    return readTableSchema(localDb, tableName);
  }

  await migrateRemoteTableSchema(remote, localDb, tableName, async () => {
    const table = readLocalTable(localDb, tableName);
    await replaceRemoteTable(remote, table);
  });

  await ensureRemoteRowSyncColumns(remote, tableName);

  columns = readTableSchema(localDb, tableName);
  await ensureRemoteTableSyncTriggers(remote, columns, tableName);
  return readTableSchema(localDb, tableName);
}

/** Tables whose local schema differs from Turso (user + platform columns). */
export async function localRemoteSchemaDriftTables(
  remote: Client,
  localDb: Database.Database,
  tableNames: readonly string[],
): Promise<string[]> {
  const drifted: string[] = [];
  for (const tableName of tableNames) {
    const localColumns = readTableSchema(localDb, tableName);
    if (localColumns.length === 0) {
      continue;
    }
    const exists = await remote.execute({
      sql: `SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`,
      args: [tableName],
    });
    if (exists.rows.length === 0) {
      drifted.push(tableName);
      continue;
    }
    const remoteColumns = await readRemoteTableSchema(remote, tableName);
    if (!fullSchemasMatch(localColumns, remoteColumns)) {
      drifted.push(tableName);
    }
  }
  return drifted;
}

/** User-column drift only — for UI status (ignores platform _papr_* columns). */
export async function localRemoteUserSchemaDriftTables(
  remote: Client,
  localDb: Database.Database,
  tableNames: readonly string[],
): Promise<string[]> {
  const drifted: string[] = [];
  for (const tableName of tableNames) {
    const localColumns = readTableSchema(localDb, tableName);
    if (localColumns.length === 0) {
      continue;
    }
    const exists = await remote.execute({
      sql: `SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`,
      args: [tableName],
    });
    if (exists.rows.length === 0) {
      drifted.push(tableName);
      continue;
    }
    const remoteColumns = await readRemoteTableSchema(remote, tableName);
    if (!userSchemasMatch(localColumns, remoteColumns)) {
      drifted.push(tableName);
    }
  }
  return drifted;
}

/** Push changelog entries from local → Turso. Returns touched table names. */
export async function pushDeltaToRemote(
  localDb: Database.Database,
  remote: Client,
  entries: readonly SyncLogEntry[],
): Promise<string[]> {
  const touched = new Set<string>();
  const schemaCache = new Map<string, TableColumn[]>();

  for (const entry of entries) {
    let columns = schemaCache.get(entry.tableName);
    if (!columns) {
      columns = await prepareRemoteTableForSync(
        remote,
        localDb,
        entry.tableName,
      );
      schemaCache.set(entry.tableName, columns);
    }
    if (columns.length === 0) {
      continue;
    }

    if (entry.op === "delete") {
      await deleteRemoteRowByPk(remote, entry.tableName, columns, entry.rowPk);
      touched.add(entry.tableName);
      continue;
    }

    const row = fetchLocalRowByPk(localDb, entry.tableName, columns, entry.rowPk);
    if (!row) {
      await deleteRemoteRowByPk(remote, entry.tableName, columns, entry.rowPk);
    } else {
      await upsertRemoteRow(
        remote,
        entry.tableName,
        columns,
        row,
        entry.rowPk,
      );
    }
    touched.add(entry.tableName);
  }

  return [...touched];
}

/** Apply remote changelog entries to local SQLite (caller must wrap with withSyncMuted). */
export async function applyRemoteSyncLogToLocal(
  localDb: Database.Database,
  remote: Client,
  entries: readonly SyncLogEntry[],
): Promise<string[]> {
  const touched = new Set<string>();
  const schemaCache = new Map<string, TableColumn[]>();
  const rowSyncReady = new Set<string>();

  for (const entry of entries) {
    let columns = schemaCache.get(entry.tableName);
    if (!columns) {
      columns = readTableSchema(localDb, entry.tableName);
      if (columns.length > 0) {
        await migrateLocalTableSchema(localDb, remote, entry.tableName);
        columns = readTableSchema(localDb, entry.tableName);
      }
      if (columns.length === 0) {
        const remoteCols = await remote.execute(
          `PRAGMA table_info(${quoteIdent(entry.tableName)})`,
        );
        columns = remoteCols.rows.map((row) => ({
          name: String(row.name ?? ""),
          type: String(row.type ?? "TEXT"),
          primaryKey: Number(row.pk ?? 0) > 0,
        }));
        if (columns.length > 0) {
          localDb.exec(
            `CREATE TABLE IF NOT EXISTS ${quoteIdent(entry.tableName)} (` +
              columns
                .map((col) => {
                  const pk =
                    columns!.filter((c) => c.primaryKey).length === 1 && col.primaryKey
                      ? " PRIMARY KEY"
                      : "";
                  return `${quoteIdent(col.name)} ${col.type || "TEXT"}${pk}`;
                })
                .join(", ") +
              `)`,
          );
        }
      }
      schemaCache.set(entry.tableName, columns);
    }
    if (columns.length === 0) {
      continue;
    }

    if (!rowSyncReady.has(entry.tableName)) {
      columns = await prepareRemoteTableForSync(remote, localDb, entry.tableName);
      schemaCache.set(entry.tableName, columns);
      rowSyncReady.add(entry.tableName);
    }

    if (entry.op === "delete") {
      deleteLocalRowByPk(localDb, entry.tableName, columns, entry.rowPk);
      touched.add(entry.tableName);
      continue;
    }

    const row = await fetchRemoteRowByPk(remote, entry.tableName, columns, entry.rowPk);
    if (!row) {
      deleteLocalRowByPk(localDb, entry.tableName, columns, entry.rowPk);
    } else {
      upsertLocalRow(localDb, entry.tableName, columns, row, entry.rowPk);
    }
    touched.add(entry.tableName);
  }

  return [...touched];
}
