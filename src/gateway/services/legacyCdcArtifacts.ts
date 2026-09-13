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
]);

/**
 * Tables the Plan A replica engine creates and owns.
 *
 * These names appear in {@link LEGACY_CDC_ARTIFACT_EXACT} too, and both readings are
 * right — but only one at a time. Before cutover they are legacy debris and must go.
 * *After* cutover they are the engine's live bookkeeping: every healthy replica carries
 * `turso_cdc`, `turso_cdc_version`, and `turso_sync_last_change_id`, and the engine
 * reads them back through native Rust.
 *
 * So a caller operating on an already-cutover replica has to say so — see the
 * `preserveEngineTables` option. Dropping these from a live replica forces the engine to
 * re-derive its sync cursor on every startup, and if anything recreates one with the
 * wrong shape in between, the engine aborts the process seeking an index that is not
 * there (see `tursoReplica/replicaEngineTableGuard.ts`).
 */
const REPLICA_ENGINE_OWNED_EXACT = new Set([
  "turso_cdc",
  "turso_cdc_version",
  "turso_sync_last_change_id",
]);

/** True when the Plan A replica engine owns this table on an already-cutover replica. */
export function isReplicaEngineOwnedTable(tableName: string): boolean {
  return (
    REPLICA_ENGINE_OWNED_EXACT.has(tableName) || tableName.startsWith("turso_cdc_")
  );
}

export interface LegacyTableScopeOptions {
  /**
   * Set on an already-cutover Plan A replica: keep the engine's own tables rather than
   * treating them as legacy debris. Defaults to false, which preserves the pre-cutover
   * reading for provision and cutover callers.
   */
  preserveEngineTables?: boolean;
}

export function isLegacyCdcArtifactTable(
  tableName: string,
  options?: LegacyTableScopeOptions,
): boolean {
  if (options?.preserveEngineTables && isReplicaEngineOwnedTable(tableName)) {
    return false;
  }
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
export function isLegacySyncPathTable(
  tableName: string,
  options?: LegacyTableScopeOptions,
): boolean {
  if (tableName === "schema_migrations" || tableName === "_papr_schema_migrations") {
    return false;
  }
  if (options?.preserveEngineTables && isReplicaEngineOwnedTable(tableName)) {
    return false;
  }
  if (isLegacyCdcArtifactTable(tableName, options)) {
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

/** User app tables only — excludes legacy CDC and sync-path infra for schema pairing. */
export function filterUserSchemaComparisonTables(tables: readonly string[]): string[] {
  return tables.filter((name) => !isLegacySyncPathTable(name));
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
export function listLegacySyncPathTablesForPath(
  dbPath: string,
  options?: LegacyTableScopeOptions,
): string[] {
  return listLegacyTablesForPath(dbPath, (tableName) =>
    isLegacySyncPathTable(tableName, options),
  );
}

/**
 * Drop legacy sync-path tables and CDC triggers. Preserves user app tables and
 * Plan A migration ledgers (`schema_migrations`, `_papr_schema_migrations`).
 */
export function stripLegacySyncPathArtifacts(
  dbPath: string,
  options?: LegacyTableScopeOptions,
): string[] {
  if (!fs.existsSync(dbPath)) {
    return [];
  }
  const db = new Database(dbPath);
  try {
    const dropped: string[] = [];
    for (const tableName of listSqliteUserTables(db).filter((name) =>
      isLegacySyncPathTable(name, options),
    )) {
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
