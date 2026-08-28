/**
 * Pre-_papr_* legacy CDC metadata tables — local-only artifacts, not user data.
 * Excluded from syncable table counts and schema drift checks; stripped at cutover.
 */

import * as fs from "fs";
import Database from "better-sqlite3";

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Known legacy table names from Papr v1 / early CDC experiments. */
const LEGACY_CDC_ARTIFACT_EXACT = new Set([
  "turso_sync_last_change_id",
  "turso_sync_state",
  "turso_sync_cursor",
  "turso_sync_meta",
  "turso_sync_log",
  "turso_sync_registry",
  "turso_cdc",
  "turso_cdc_version",
  /** Legacy job/registry migration ledger — Plan A uses _papr_schema_migrations. */
  "schema_migrations",
]);

export function isLegacyCdcArtifactTable(tableName: string): boolean {
  if (LEGACY_CDC_ARTIFACT_EXACT.has(tableName)) {
    return true;
  }
  if (tableName === "turso_cdc" || tableName.startsWith("turso_cdc_")) {
    return true;
  }
  if (tableName.startsWith("__turso_internal")) {
    return true;
  }
  return false;
}

function listSqliteUserTables(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => String(row.name ?? "")).filter(Boolean);
}

/** Legacy artifact tables still present on disk (for diagnostics / cutover strip). */
export function listLegacyCdcArtifactTablesForPath(dbPath: string): string[] {
  if (!fs.existsSync(dbPath)) {
    return [];
  }
  try {
    const stats = fs.statSync(dbPath);
    if (stats.size === 0) {
      return [];
    }
    const db = new Database(dbPath, { readonly: true });
    try {
      return listSqliteUserTables(db).filter(isLegacyCdcArtifactTable);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * Drop local-only legacy CDC artifact tables before replica cutover.
 * Returns dropped table names (empty when none found).
 */
export function stripLegacyCdcArtifacts(dbPath: string): string[] {
  if (!fs.existsSync(dbPath)) {
    return [];
  }
  const db = new Database(dbPath);
  try {
    const dropped: string[] = [];
    for (const tableName of listSqliteUserTables(db).filter(
      isLegacyCdcArtifactTable,
    )) {
      db.exec(`DROP TABLE IF EXISTS ${quoteIdent(tableName)}`);
      dropped.push(tableName);
    }
    return dropped;
  } finally {
    db.close();
  }
}
