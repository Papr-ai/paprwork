/**
 * Contract convergence hash (SYNC_CONTRACT §10 Phase 4).
 * Per table: (row_count, hash(primary_key ‖ _papr_row_version ‖ _papr_updated_at))
 */

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";

export interface TableConvergenceDigest {
  tableName: string;
  rowCount: number;
  contentHash: string;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function tableHasColumn(db: Database.Database, tableName: string, column: string): boolean {
  const rows = db
    .prepare(`PRAGMA table_info(${quoteIdent(tableName)})`)
    .all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function resolveOrderColumn(db: Database.Database, tableName: string): string | null {
  if (tableHasColumn(db, tableName, "rowid")) {
    return "rowid";
  }
  const pkRows = db
    .prepare(`PRAGMA table_info(${quoteIdent(tableName)})`)
    .all() as Array<{ name: string; pk: number }>;
  const pk = pkRows.find((row) => row.pk === 1);
  return pk?.name ?? null;
}

export function computeLocalTableConvergenceDigest(
  db: Database.Database,
  tableName: string,
): TableConvergenceDigest | null {
  const quoted = quoteIdent(tableName);
  const countRow = db
    .prepare(`SELECT COUNT(*) AS count FROM ${quoted}`)
    .get() as { count: number };
  const rowCount = countRow.count;

  const hasVersion = tableHasColumn(db, tableName, "_papr_row_version");
  const hasUpdated = tableHasColumn(db, tableName, "_papr_updated_at");
  const orderCol = resolveOrderColumn(db, tableName);

  if (!orderCol) {
    const hash = createHash("sha256")
      .update(`${tableName}:count:${rowCount}`)
      .digest("hex")
      .slice(0, 16);
    return { tableName, rowCount, contentHash: hash };
  }

  const selectCols = [
    `${quoteIdent(orderCol)} AS _pk`,
    hasVersion ? "_papr_row_version" : "NULL AS _papr_row_version",
    hasUpdated ? "_papr_updated_at" : "NULL AS _papr_updated_at",
  ].join(", ");

  const rows = db
    .prepare(`SELECT ${selectCols} FROM ${quoted} ORDER BY ${quoteIdent(orderCol)}`)
    .all() as Array<Record<string, unknown>>;

  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(String(row._pk ?? ""));
    hash.update("|");
    hash.update(String(row._papr_row_version ?? ""));
    hash.update("|");
    hash.update(String(row._papr_updated_at ?? ""));
    hash.update("\n");
  }

  return {
    tableName,
    rowCount,
    contentHash: hash.digest("hex").slice(0, 16),
  };
}

export async function computeRemoteTableConvergenceDigest(
  remote: Client,
  tableName: string,
): Promise<TableConvergenceDigest | null> {
  const quoted = quoteIdent(tableName);

  const countResult = await remote.execute(`SELECT COUNT(*) AS count FROM ${quoted}`);
  const rowCount = Number(countResult.rows[0]?.count ?? 0);

  const columnsResult = await remote.execute(
    `PRAGMA table_info(${quoteIdent(tableName)})`,
  );
  const columnNames = columnsResult.rows.map((row) => String(row.name ?? ""));
  const hasVersion = columnNames.includes("_papr_row_version");
  const hasUpdated = columnNames.includes("_papr_updated_at");
  const pkCol =
    columnsResult.rows.find((row) => Number(row.pk) === 1)?.name?.toString() ??
    (columnNames.includes("rowid") ? "rowid" : null);

  if (!pkCol) {
    const hash = createHash("sha256")
      .update(`${tableName}:count:${rowCount}`)
      .digest("hex")
      .slice(0, 16);
    return { tableName, rowCount, contentHash: hash };
  }

  const selectCols = [
    `${quoteIdent(pkCol)} AS _pk`,
    hasVersion ? "_papr_row_version" : "NULL AS _papr_row_version",
    hasUpdated ? "_papr_updated_at" : "NULL AS _papr_updated_at",
  ].join(", ");

  const rowsResult = await remote.execute(
    `SELECT ${selectCols} FROM ${quoted} ORDER BY ${quoteIdent(pkCol)}`,
  );

  const hash = createHash("sha256");
  for (const row of rowsResult.rows) {
    hash.update(String(row._pk ?? ""));
    hash.update("|");
    hash.update(String(row._papr_row_version ?? ""));
    hash.update("|");
    hash.update(String(row._papr_updated_at ?? ""));
    hash.update("\n");
  }

  return {
    tableName,
    rowCount,
    contentHash: hash.digest("hex").slice(0, 16),
  };
}

export function digestsMatch(
  local: TableConvergenceDigest,
  remote: TableConvergenceDigest,
): boolean {
  return (
    local.rowCount === remote.rowCount &&
    local.contentHash === remote.contentHash
  );
}
