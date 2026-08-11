/**
 * Chunked local SQLite writes for Turso pull paths (delta + full snapshot).
 */

import type Database from "better-sqlite3";
import { quoteIdent, type TableColumn } from "./tursoSyncBridgeCore.js";
import { REMOTE_DELETE_PK_CHUNK, REMOTE_INSERT_CHUNK_ROWS } from "./tursoBulkInsert.js";

export { REMOTE_INSERT_CHUNK_ROWS as LOCAL_INSERT_CHUNK_ROWS } from "./tursoBulkInsert.js";

function buildLocalDeleteBySinglePkSql(
  tableName: string,
  pkColumn: string,
  pkCount: number,
): string {
  const placeholders = Array.from({ length: pkCount }, () => "?").join(", ");
  return (
    `DELETE FROM ${quoteIdent(tableName)} ` +
    `WHERE ${quoteIdent(pkColumn)} IN (${placeholders})`
  );
}

/** Batch-delete local rows by single-column primary key. */
export function batchDeleteLocalRowsBySinglePk(
  db: Database.Database,
  tableName: string,
  pkColumn: string,
  pks: readonly unknown[],
  chunkSize: number = REMOTE_DELETE_PK_CHUNK,
): void {
  if (pks.length === 0) {
    return;
  }
  for (let offset = 0; offset < pks.length; offset += chunkSize) {
    const chunk = pks.slice(offset, offset + chunkSize);
    db.prepare(buildLocalDeleteBySinglePkSql(tableName, pkColumn, chunk.length)).run(
      ...chunk,
    );
  }
}

/** Batch upsert rows into local SQLite using INSERT OR REPLACE. */
export function batchUpsertLocalRows(
  db: Database.Database,
  tableName: string,
  columns: TableColumn[],
  rows: readonly unknown[][],
  chunkSize: number = REMOTE_INSERT_CHUNK_ROWS,
): void {
  if (rows.length === 0 || columns.length === 0) {
    return;
  }
  const placeholders = columns.map(() => "?").join(", ");
  const colNames = columns.map((col) => quoteIdent(col.name)).join(", ");
  const insert = db.prepare(
    `INSERT OR REPLACE INTO ${quoteIdent(tableName)} (${colNames}) VALUES (${placeholders})`,
  );
  const writeChunk = db.transaction((chunk: unknown[][]) => {
    for (const row of chunk) {
      insert.run(...row);
    }
  });
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    writeChunk(rows.slice(offset, offset + chunkSize));
  }
}
