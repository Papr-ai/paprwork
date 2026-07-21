/**
 * Lazy schema seed for per-user Turso databases — copy empty tables from shared base.
 */

import type { Client } from "@libsql/client";
import {
  buildCreateTableSql,
  quoteIdent,
  type TableColumn,
} from "./tursoSyncBridgeCore.js";
import { JOB_BASELINE_TABLES } from "./appDataSources.js";

async function readRemoteTableColumns(
  client: Client,
  tableName: string,
): Promise<TableColumn[]> {
  const result = await client.execute(
    `PRAGMA table_info(${quoteIdent(tableName)})`,
  );
  return result.rows.map((row) => ({
    name: String(row.name ?? ""),
    type: String(row.type ?? "TEXT"),
    primaryKey: Number(row.pk ?? 0) > 0,
  }));
}

async function listUserTables(client: Client): Promise<string[]> {
  const result = await client.execute({
    sql: `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    args: [],
  });
  return result.rows
    .map((row) => String(row.name ?? ""))
    .filter(
      (name) =>
        name.length > 0 &&
        !name.startsWith("_papr_") &&
        !JOB_BASELINE_TABLES.has(name),
    );
}

/**
 * When a per-user Turso DB is empty, copy table schemas (no rows) from the shared base DB.
 */
export async function seedPerUserSchemaFromBase(
  perUserClient: Client,
  baseClient: Client,
): Promise<number> {
  const existing = await listUserTables(perUserClient);
  if (existing.length > 0) {
    return 0;
  }

  const baseTables = await listUserTables(baseClient);
  let created = 0;
  for (const tableName of baseTables) {
    const columns = await readRemoteTableColumns(baseClient, tableName);
    if (columns.length === 0) {
      continue;
    }
    const ddl = buildCreateTableSql({
      name: tableName,
      columns,
      rows: [],
    });
    await perUserClient.execute(ddl);
    created += 1;
  }
  return created;
}
