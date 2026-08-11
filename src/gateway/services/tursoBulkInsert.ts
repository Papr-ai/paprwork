/**
 * Chunked multi-row INSERT/UPSERT for Turso remote.batch / execute.
 * Avoids one-statement-per-row overhead on large snapshot/bootstrap paths.
 */

import type { Client, InArgs } from "@libsql/client";

/** Rows per INSERT statement (multi-value form). */
export const REMOTE_INSERT_CHUNK_ROWS = 500;

/** Rows per remote SELECT page during full pull (sandbox bootstrap). */
export const REMOTE_READ_CHUNK_ROWS = 2_000;

/** PKs per DELETE … WHERE pk IN (…) batch when reconciling orphans. */
export const REMOTE_DELETE_PK_CHUNK = 500;

interface BulkInsertColumn {
  name: string;
}

type RowInsertMode = "insert" | "upsert";

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function buildMultiRowInsertSql(
  tableName: string,
  columns: BulkInsertColumn[],
  rowCount: number,
  mode: RowInsertMode,
): string {
  const colNames = columns.map((col) => quoteIdent(col.name)).join(", ");
  const rowPlaceholder = `(${columns.map(() => "?").join(", ")})`;
  const valueGroups = Array.from({ length: rowCount }, () => rowPlaceholder).join(
    ", ",
  );
  const verb =
    mode === "upsert" ? "INSERT OR REPLACE INTO" : "INSERT INTO";
  return `${verb} ${quoteIdent(tableName)} (${colNames}) VALUES ${valueGroups}`;
}

/** Insert or upsert local table rows using multi-value INSERT statements. */
export async function batchInsertLocalTableRows(
  remote: Client,
  tableName: string,
  columns: BulkInsertColumn[],
  rows: readonly unknown[][],
  mode: RowInsertMode,
  chunkSize: number = REMOTE_INSERT_CHUNK_ROWS,
): Promise<void> {
  if (rows.length === 0 || columns.length === 0) {
    return;
  }

  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const sql = buildMultiRowInsertSql(tableName, columns, chunk.length, mode);
    const args: (string | number | bigint | null | Uint8Array)[] = [];
    for (const row of chunk) {
      for (const value of row) {
        args.push(value as string | number | bigint | null | Uint8Array);
      }
    }
    await remote.execute({ sql, args });
  }
}

/** Delete remote rows whose PKs are not present locally (batched IN deletes). Returns deleted PK values. */
export async function deleteRemoteOrphanRowsByPk(
  remote: Client,
  tableName: string,
  pkColumn: string,
  localPks: readonly unknown[],
  chunkSize: number = REMOTE_DELETE_PK_CHUNK,
): Promise<unknown[]> {
  const localPkSet = new Set(localPks.map((pk) => pkKey(pk)));
  const result = await remote.execute(
    `SELECT ${quoteIdent(pkColumn)} AS pk FROM ${quoteIdent(tableName)}`,
  );

  const deletedPks: unknown[] = [];
  const orphanKeys: unknown[] = [];
  for (const row of result.rows) {
    const pk = row.pk;
    if (pkKey(pk) === undefined) {
      continue;
    }
    if (!localPkSet.has(pkKey(pk)!)) {
      orphanKeys.push(pk);
      if (orphanKeys.length >= chunkSize) {
        await deleteRemoteRowsByPks(remote, tableName, pkColumn, orphanKeys);
        deletedPks.push(...orphanKeys);
        orphanKeys.length = 0;
      }
    }
  }
  if (orphanKeys.length > 0) {
    await deleteRemoteRowsByPks(remote, tableName, pkColumn, orphanKeys);
    deletedPks.push(...orphanKeys);
  }
  return deletedPks;
}

export async function deleteRemoteRowsByPks(
  remote: Client,
  tableName: string,
  pkColumn: string,
  pks: readonly unknown[],
): Promise<void> {
  if (pks.length === 0) {
    return;
  }
  const placeholders = pks.map(() => "?").join(", ");
  await remote.execute({
    sql: `DELETE FROM ${quoteIdent(tableName)} WHERE ${quoteIdent(pkColumn)} IN (${placeholders})`,
    args: pks as InArgs,
  });
}

export function syncValueCacheKey(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "bigint") {
    return `bigint:${value.toString()}`;
  }
  return `${typeof value}:${String(value)}`;
}

function pkKey(value: unknown): string | undefined {
  return syncValueCacheKey(value);
}

/** Batch-fetch remote rows by single-column primary key (for LWW filtering). */
export async function fetchRemoteRowsBySinglePk(
  remote: Client,
  tableName: string,
  localColumns: readonly BulkInsertColumn[],
  pkColumn: string,
  pks: readonly unknown[],
  chunkSize: number = REMOTE_DELETE_PK_CHUNK,
): Promise<Map<string, unknown[]>> {
  const map = new Map<string, unknown[]>();
  if (pks.length === 0 || localColumns.length === 0) {
    return map;
  }

  const remoteColumns = await remote.execute(
    `PRAGMA table_info(${quoteIdent(tableName)})`,
  );
  const colList = remoteColumns.rows
    .map((row) => quoteIdent(String(row.name ?? "")))
    .join(", ");

  for (let offset = 0; offset < pks.length; offset += chunkSize) {
    const chunk = pks.slice(offset, offset + chunkSize);
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await remote.execute({
      sql:
        `SELECT ${colList} FROM ${quoteIdent(tableName)} ` +
        `WHERE ${quoteIdent(pkColumn)} IN (${placeholders})`,
      args: chunk as InArgs,
    });
    for (const rowObj of result.rows) {
      const pkVal = rowObj[pkColumn];
      const key = syncValueCacheKey(pkVal);
      if (!key) {
        continue;
      }
      map.set(
        key,
        localColumns.map((col) => rowObj[col.name] ?? null),
      );
    }
  }

  return map;
}
