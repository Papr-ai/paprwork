/**
 * Apply schema migration payloads to local SQLite (LogMaterializer catch-up).
 */

import type Database from "better-sqlite3";
import type { JobMigrationSchemaOp } from "../../../core/types/jobMigrations.js";
import { quoteIdent } from "../tursoSyncBridgeCore.js";
import {
  isDuplicateColumnError,
  parseAddColumnStatement,
  splitSqlStatements,
} from "../jobs/migrationSqlHelpers.js";
import {
  ensureSchemaMigrationsTable,
  listAppliedMigrationIdsReadOnly,
} from "../jobs/schemaMigrationsLedger.js";
import { normalizeMigrationId } from "../jobs/migrationIdNormalize.js";
import type { WorkspaceLogSchemaPayload } from "../../../core/types/workspaceLog.js";

function localTableHasColumn(
  db: Database.Database,
  tableName: string,
  columnName: string,
): boolean {
  const rows = db
    .prepare(`PRAGMA table_info(${quoteIdent(tableName)})`)
    .all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

function localTableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`,
    )
    .get(tableName) as { ok: number } | undefined;
  return Boolean(row?.ok);
}

function applySchemaOpToLocal(
  db: Database.Database,
  op: JobMigrationSchemaOp,
): void {
  switch (op.kind) {
    case "add_column":
      if (!localTableExists(db, op.table)) {
        return;
      }
      if (localTableHasColumn(db, op.table, op.column)) {
        return;
      }
      try {
        db.exec(
          `ALTER TABLE ${quoteIdent(op.table)} ADD COLUMN ${quoteIdent(op.column)} ${op.type.trim() || "TEXT"}`,
        );
      } catch (error) {
        if (!isDuplicateColumnError(error)) {
          throw error;
        }
      }
      return;
    case "drop_column":
      if (!localTableExists(db, op.table)) {
        return;
      }
      db.exec(
        `ALTER TABLE ${quoteIdent(op.table)} DROP COLUMN ${quoteIdent(op.column)}`,
      );
      return;
    case "rename_column":
      if (!localTableExists(db, op.table)) {
        return;
      }
      db.exec(
        `ALTER TABLE ${quoteIdent(op.table)} RENAME COLUMN ${quoteIdent(op.from)} TO ${quoteIdent(op.to)}`,
      );
      return;
    case "sql":
      applyLocalSqlIdempotent(db, op.statement);
      return;
  }
}

function applyLocalSqlIdempotent(db: Database.Database, statement: string): void {
  const trimmed = statement.trim();
  if (!trimmed) {
    return;
  }
  const addColumn = parseAddColumnStatement(trimmed);
  if (addColumn) {
    if (!localTableExists(db, addColumn.table)) {
      return;
    }
    if (localTableHasColumn(db, addColumn.table, addColumn.column)) {
      return;
    }
  }
  try {
    db.exec(trimmed);
  } catch (error) {
    if (isDuplicateColumnError(error)) {
      return;
    }
    throw error;
  }
}

function isMigrationAppliedLocally(
  db: Database.Database,
  migrationId: string,
): boolean {
  const normalized = normalizeMigrationId(migrationId);
  const applied = listAppliedMigrationIdsReadOnly(db).map(normalizeMigrationId);
  return applied.includes(normalized);
}

function recordLocalMigrationApplied(
  db: Database.Database,
  migrationId: string,
): void {
  ensureSchemaMigrationsTable(db);
  const normalized = normalizeMigrationId(migrationId);
  db.prepare(
    `INSERT OR IGNORE INTO ${quoteIdent("schema_migrations")} (id, applied_at) VALUES (?, ?)`,
  ).run(normalized, new Date().toISOString());
}

/** Apply migrationId schema payload locally if not already in schema_migrations. */
export function applyMigrationSchemaPayloadLocally(
  db: Database.Database,
  payload: WorkspaceLogSchemaPayload,
): boolean {
  const migrationId = payload.migrationId?.trim();
  if (!migrationId) {
    return false;
  }
  if (isMigrationAppliedLocally(db, migrationId)) {
    return false;
  }

  if (payload.ops?.length) {
    for (const op of payload.ops) {
      applySchemaOpToLocal(db, op);
    }
  } else if (payload.statements?.length) {
    for (const statement of payload.statements) {
      applyLocalSqlIdempotent(db, statement);
    }
  } else if (payload.sql?.trim()) {
    applyLocalSqlIdempotent(db, payload.sql);
  } else {
    return false;
  }

  recordLocalMigrationApplied(db, migrationId);
  return true;
}

/** Inline runtime CREATE TABLE schema (no migrationId). */
export function applyInlineSchemaSqlLocally(
  db: Database.Database,
  sql: string,
): void {
  const trimmed = sql.trim();
  if (!trimmed.toLowerCase().startsWith("create table if not exists")) {
    throw new Error("Inline schema SQL must be CREATE TABLE IF NOT EXISTS");
  }
  db.exec(trimmed);
}

export { applySchemaOpToLocal, splitSqlStatements };
