/**
 * Legacy sync-path artifacts — local-only tables/triggers, not user app data.
 * Stripped at replica cutover and on startup repair so Plan A uses Turso Sync only.
 */

import * as fs from "fs";
import Database from "better-sqlite3";
import {
  filterSyncableTables,
  listUserTables,
} from "./tursoSyncBridgeCore.js";
import { SYNC_INFRA_TABLES } from "./tursoSyncLog.js";
import { dropLocalTableSyncTriggers } from "./tursoSyncLog.js";

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

/** V3 CDC / workspace-log tables and pre-_papr turso_* artifacts — not used by Plan A replica. */
export function isLegacySyncPathTable(tableName: string): boolean {
  if (tableName === "_papr_schema_migrations") {
    return false;
  }
  if (isLegacyCdcArtifactTable(tableName)) {
    return true;
  }
  if (SYNC_INFRA_TABLES.has(tableName)) {
    return true;
  }
  if (tableName === "_papr_sync_meta") {
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

function listLegacyTablesForPath(
  dbPath: string,
  predicate: (tableName: string) => boolean,
): string[] {
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
      return listSqliteUserTables(db).filter(predicate);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/** Legacy turso_* artifact tables still present on disk. */
export function listLegacyCdcArtifactTablesForPath(dbPath: string): string[] {
  return listLegacyTablesForPath(dbPath, isLegacyCdcArtifactTable);
}

/** Legacy sync-path tables (V3 CDC + workspace log) still on a Plan A replica file. */
export function listLegacySyncPathTablesForPath(dbPath: string): string[] {
  return listLegacyTablesForPath(dbPath, isLegacySyncPathTable);
}

/**
 * Drop legacy sync-path tables and CDC triggers. Preserves user app tables and
 * `_papr_schema_migrations` (Plan A schema ledger).
 */
export function stripLegacySyncPathArtifacts(dbPath: string): string[] {
  if (!fs.existsSync(dbPath)) {
    return [];
  }
  const db = new Database(dbPath);
  try {
    const dropped: string[] = [];
    for (const tableName of listSqliteUserTables(db).filter(isLegacySyncPathTable)) {
      db.exec(`DROP TABLE IF EXISTS ${quoteIdent(tableName)}`);
      dropped.push(tableName);
    }
    for (const tableName of filterSyncableTables(listUserTables(db))) {
      dropLocalTableSyncTriggers(db, tableName);
    }
    return dropped;
  } finally {
    db.close();
  }
}

/** @deprecated Prefer stripLegacySyncPathArtifacts — kept for call sites that only strip turso_* tables. */
export function stripLegacyCdcArtifacts(dbPath: string): string[] {
  return stripLegacySyncPathArtifacts(dbPath);
}
