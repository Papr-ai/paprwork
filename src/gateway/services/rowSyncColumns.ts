/**
 * Platform-managed row metadata for synced user tables (registry + linked DBs).
 * Lazy-added on first CDC trigger install — agents never manage these columns.
 */

import type { Client } from "@libsql/client";
import type Database from "better-sqlite3";
import { PAPR_ROW_SYNC_COLUMNS } from "../../core/types/jobMigrations.js";
import { quoteIdent, readRemoteTableSchema, readTableSchema, type TableColumn } from "./tursoSyncBridgeCore.js";

export { PAPR_ROW_SYNC_COLUMNS };

const SYNC_MUTE_TABLE = "_papr_sync_mute";
const MUTE_ROW_ID = 1;

const SYNC_MUTE_GUARD =
  `(SELECT COALESCE((SELECT depth FROM _papr_sync_mute WHERE id = 1), 0)) = 0`;

function triggerSuffix(tableName: string): string {
  return tableName.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40);
}

function columnNames(columns: readonly TableColumn[]): Set<string> {
  return new Set(columns.map((col) => col.name));
}

function hasColumn(columns: readonly TableColumn[], name: string): boolean {
  return columnNames(columns).has(name);
}

function rowVersionTriggerName(tableName: string): string {
  return `_papr_bump_${triggerSuffix(tableName)}`;
}

function rowCreatedTriggerName(tableName: string): string {
  return `_papr_created_${triggerSuffix(tableName)}`;
}

export function dropLocalRowSyncTriggers(
  db: Database.Database,
  tableName: string,
): void {
  for (const name of [
    rowCreatedTriggerName(tableName),
    rowVersionTriggerName(tableName),
  ]) {
    db.exec(`DROP TRIGGER IF EXISTS ${quoteIdent(name)}`);
  }
}

export async function dropRemoteRowSyncTriggers(
  remote: Client,
  tableName: string,
): Promise<void> {
  for (const name of [
    rowCreatedTriggerName(tableName),
    rowVersionTriggerName(tableName),
  ]) {
    await remote.execute({
      sql: `DROP TRIGGER IF EXISTS ${quoteIdent(name)}`,
      args: [],
    });
  }
}

function buildAlterColumnStatements(
  tableName: string,
  columns: readonly TableColumn[],
): string[] {
  const quoted = quoteIdent(tableName);
  const statements: string[] = [];
  // SQLite ALTER TABLE only allows constant DEFAULT values (not datetime('now')).
  // Timestamps are nullable — existing rows stay NULL; INSERT/UPDATE triggers set them going forward.
  if (!hasColumn(columns, PAPR_ROW_SYNC_COLUMNS.createdAt)) {
    statements.push(
      `ALTER TABLE ${quoted} ADD COLUMN ${quoteIdent(PAPR_ROW_SYNC_COLUMNS.createdAt)} TEXT`,
    );
  }
  if (!hasColumn(columns, PAPR_ROW_SYNC_COLUMNS.updatedAt)) {
    statements.push(
      `ALTER TABLE ${quoted} ADD COLUMN ${quoteIdent(PAPR_ROW_SYNC_COLUMNS.updatedAt)} TEXT`,
    );
  }
  if (!hasColumn(columns, PAPR_ROW_SYNC_COLUMNS.rowVersion)) {
    statements.push(
      `ALTER TABLE ${quoted} ADD COLUMN ${quoteIdent(PAPR_ROW_SYNC_COLUMNS.rowVersion)} INTEGER NOT NULL DEFAULT 1`,
    );
  }
  return statements;
}

/** Column names from {@link PAPR_ROW_SYNC_COLUMNS} absent in `columns` (remote schema check). */
export function missingRowSyncColumnNames(
  columns: readonly TableColumn[],
): string[] {
  const names: string[] = [];
  if (!hasColumn(columns, PAPR_ROW_SYNC_COLUMNS.createdAt)) {
    names.push(PAPR_ROW_SYNC_COLUMNS.createdAt);
  }
  if (!hasColumn(columns, PAPR_ROW_SYNC_COLUMNS.updatedAt)) {
    names.push(PAPR_ROW_SYNC_COLUMNS.updatedAt);
  }
  if (!hasColumn(columns, PAPR_ROW_SYNC_COLUMNS.rowVersion)) {
    names.push(PAPR_ROW_SYNC_COLUMNS.rowVersion);
  }
  return names;
}

function rowTimestampsUnsetExpr(): string {
  const col = quoteIdent(PAPR_ROW_SYNC_COLUMNS.createdAt);
  return `(NEW.${col} IS NULL OR NEW.${col} = '')`;
}

function buildRowSyncTriggerStatements(tableName: string): string[] {
  const quoted = quoteIdent(tableName);
  const bumpName = rowVersionTriggerName(tableName);
  const createdName = rowCreatedTriggerName(tableName);
  return [
    `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(createdName)} ` +
      `AFTER INSERT ON ${quoted} ` +
      `FOR EACH ROW ` +
      `WHEN ${rowTimestampsUnsetExpr()} ` +
      `AND ${SYNC_MUTE_GUARD} ` +
      `BEGIN ` +
      `UPDATE ${quoteIdent(SYNC_MUTE_TABLE)} SET depth = depth + 1 WHERE id = ${MUTE_ROW_ID}; ` +
      `UPDATE ${quoted} SET ` +
      `${quoteIdent(PAPR_ROW_SYNC_COLUMNS.createdAt)} = datetime('now'), ` +
      `${quoteIdent(PAPR_ROW_SYNC_COLUMNS.updatedAt)} = datetime('now') ` +
      `WHERE rowid = NEW.rowid; ` +
      `UPDATE ${quoteIdent(SYNC_MUTE_TABLE)} SET depth = depth - 1 WHERE id = ${MUTE_ROW_ID}; ` +
      `END`,
    `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(bumpName)} ` +
      `AFTER UPDATE ON ${quoted} ` +
      `FOR EACH ROW ` +
      `WHEN OLD.${quoteIdent(PAPR_ROW_SYNC_COLUMNS.rowVersion)} = NEW.${quoteIdent(PAPR_ROW_SYNC_COLUMNS.rowVersion)} ` +
      `AND ${SYNC_MUTE_GUARD} ` +
      `BEGIN ` +
      `UPDATE ${quoted} SET ` +
      `${quoteIdent(PAPR_ROW_SYNC_COLUMNS.updatedAt)} = datetime('now'), ` +
      `${quoteIdent(PAPR_ROW_SYNC_COLUMNS.rowVersion)} = OLD.${quoteIdent(PAPR_ROW_SYNC_COLUMNS.rowVersion)} + 1 ` +
      `WHERE rowid = NEW.rowid; ` +
      `END`,
  ];
}

/** SQL for manual migrations (optional — platform auto-adds on sync). */
export function rowVersionMigrationSql(tableName: string): string {
  const emptyCols: TableColumn[] = [];
  const alters = buildAlterColumnStatements(tableName, emptyCols);
  const triggers = buildRowSyncTriggerStatements(tableName);
  return (
    `-- Platform row sync metadata for ${tableName} (optional — auto-added on sync)\n` +
    `${alters.join(";\n")};\n` +
    `${triggers.join(";\n")};\n`
  );
}

/** Add _papr_created_at, _papr_updated_at, _papr_row_version + triggers if missing. */
export function ensureLocalRowSyncColumns(
  db: Database.Database,
  tableName: string,
): boolean {
  let columns = readTableSchema(db, tableName);
  if (columns.length === 0) {
    return false;
  }

  for (const sql of buildAlterColumnStatements(tableName, columns)) {
    db.exec(sql);
  }
  columns = readTableSchema(db, tableName);

  dropLocalRowSyncTriggers(db, tableName);
  for (const sql of buildRowSyncTriggerStatements(tableName)) {
    db.exec(sql);
  }

  return hasColumn(columns, PAPR_ROW_SYNC_COLUMNS.rowVersion);
}

export async function ensureRemoteRowSyncColumns(
  remote: Client,
  tableName: string,
): Promise<boolean> {
  const remoteColumns = await readRemoteTableSchema(remote, tableName);
  if (remoteColumns.length === 0) {
    return false;
  }

  const pendingAlters = buildAlterColumnStatements(tableName, remoteColumns);
  for (const sql of pendingAlters) {
    await remote.execute({ sql, args: [] });
  }

  let refreshed = remoteColumns;
  if (pendingAlters.length > 0) {
    refreshed = await readRemoteTableSchema(remote, tableName);
  }

  await dropRemoteRowSyncTriggers(remote, tableName);
  for (const sql of buildRowSyncTriggerStatements(tableName)) {
    await remote.execute({ sql, args: [] });
  }

  return hasColumn(refreshed, PAPR_ROW_SYNC_COLUMNS.rowVersion);
}

function columnIndex(columns: readonly TableColumn[], name: string): number {
  return columns.findIndex((col) => col.name === name);
}

function readRowVersion(columns: readonly TableColumn[], row: readonly unknown[]): number {
  const idx = columnIndex(columns, PAPR_ROW_SYNC_COLUMNS.rowVersion);
  if (idx < 0) {
    return 0;
  }
  const value = row[idx];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function readUpdatedAt(columns: readonly TableColumn[], row: readonly unknown[]): string {
  const idx = columnIndex(columns, PAPR_ROW_SYNC_COLUMNS.updatedAt);
  if (idx < 0) {
    return "";
  }
  const value = row[idx];
  return typeof value === "string" ? value : value != null ? String(value) : "";
}

/**
 * Last-write-wins using _papr_row_version, then _papr_updated_at.
 * When version columns are absent, always apply (legacy tables).
 */
export function shouldApplyIncomingRow(
  columns: readonly TableColumn[],
  existing: readonly unknown[] | null,
  incoming: readonly unknown[],
): boolean {
  if (!existing) {
    return true;
  }

  const existingVersion = readRowVersion(columns, existing);
  const incomingVersion = readRowVersion(columns, incoming);

  if (existingVersion === 0 && incomingVersion === 0) {
    return true;
  }

  if (incomingVersion > existingVersion) {
    return true;
  }
  if (incomingVersion < existingVersion) {
    return false;
  }

  const existingUpdated = readUpdatedAt(columns, existing);
  const incomingUpdated = readUpdatedAt(columns, incoming);
  if (existingUpdated && incomingUpdated) {
    return incomingUpdated >= existingUpdated;
  }

  return true;
}
