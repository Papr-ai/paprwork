/**
 * Align remote Turso table schema with local before delta push/pull.
 */

import type { Client } from "@libsql/client";
import type Database from "better-sqlite3";
import {
  readLocalTable,
  readTableSchema,
  replaceRemoteTable,
  type TableColumn,
} from "./tursoSyncBridgeCore.js";
import { migrateRemoteTableSchema } from "./tursoSchemaMigration.js";
import { ensureRemoteTableSyncTriggers } from "./tursoSyncLog.js";
import {
  ensureLocalRowSyncColumns,
  ensureRemoteRowSyncColumns,
} from "./rowSyncColumns.js";

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
