/**
 * Apply changelog entries to local SQLite or remote Turso (delta sync).
 */

import type { Client } from "@libsql/client";
import type Database from "better-sqlite3";
import {
  filterSyncableTables,
  readRemoteTableSchema,
  readTableSchema,
} from "./tursoSyncBridgeCore.js";
import { fullSchemasMatch, userSchemasMatch } from "./tursoTableFingerprint.js";
import { prepareRemoteTableForSync } from "./tursoTablePrep.js";

export { prepareRemoteTableForSync } from "./tursoTablePrep.js";
export { pushDeltaToRemote } from "./tursoDeltaPush.js";
export { applyRemoteSyncLogToLocal } from "./tursoDeltaPull.js";

export async function remoteNeedsBootstrap(remote: Client): Promise<boolean> {
  const result = await remote.execute(
    `SELECT name FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
       AND name NOT LIKE 'libsql_%'
       AND name NOT LIKE '_papr_%'`,
  );
  return result.rows.length === 0;
}

/** User tables currently on remote Turso (excludes infra tables). */
export async function listRemoteUserTables(remote: Client): Promise<string[]> {
  const result = await remote.execute(
    `SELECT name FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
       AND name NOT LIKE 'libsql_%'
       AND name NOT LIKE '_papr_%'`,
  );
  return result.rows.map((row) => String(row.name ?? "")).filter(Boolean);
}

/** Local syncable tables missing from remote — schema drift after partial bootstrap. */
export async function remoteMissingLocalTables(
  remote: Client,
  localTableNames: readonly string[],
): Promise<string[]> {
  const remoteNames = new Set(await listRemoteUserTables(remote));
  return localTableNames.filter((name) => !remoteNames.has(name));
}

/**
 * Create any local user tables that are absent on Turso before migration replay.
 * Prevents "no such table" when migrations run CREATE INDEX / ALTER on new tables.
 */
export async function ensureRemoteTablesFromLocal(
  remote: Client,
  localDb: Database.Database,
  tableNames: readonly string[],
): Promise<string[]> {
  const missing = await remoteMissingLocalTables(remote, tableNames);
  for (const tableName of missing) {
    await prepareRemoteTableForSync(remote, localDb, tableName);
  }
  return missing;
}

/** Remote syncable tables missing from local — partial delta pull on empty sandbox. */
export async function localMissingRemoteTables(
  remote: Client,
  localTableNames: readonly string[],
): Promise<string[]> {
  const remoteNames = filterSyncableTables(await listRemoteUserTables(remote));
  const localNames = new Set(localTableNames);
  return remoteNames.filter((name) => !localNames.has(name));
}

/** Tables whose local schema differs from Turso (user + platform columns). */
export async function localRemoteSchemaDriftTables(
  remote: Client,
  localDb: Database.Database,
  tableNames: readonly string[],
): Promise<string[]> {
  const drifted: string[] = [];
  for (const tableName of tableNames) {
    const localColumns = readTableSchema(localDb, tableName);
    if (localColumns.length === 0) {
      continue;
    }
    const exists = await remote.execute({
      sql: `SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`,
      args: [tableName],
    });
    if (exists.rows.length === 0) {
      drifted.push(tableName);
      continue;
    }
    const remoteColumns = await readRemoteTableSchema(remote, tableName);
    if (!fullSchemasMatch(localColumns, remoteColumns)) {
      drifted.push(tableName);
    }
  }
  return drifted;
}

/** User-column drift only — for UI status (ignores platform _papr_* columns). */
export async function localRemoteUserSchemaDriftTables(
  remote: Client,
  localDb: Database.Database,
  tableNames: readonly string[],
): Promise<string[]> {
  const drifted: string[] = [];
  for (const tableName of tableNames) {
    const localColumns = readTableSchema(localDb, tableName);
    if (localColumns.length === 0) {
      continue;
    }
    const exists = await remote.execute({
      sql: `SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`,
      args: [tableName],
    });
    if (exists.rows.length === 0) {
      drifted.push(tableName);
      continue;
    }
    const remoteColumns = await readRemoteTableSchema(remote, tableName);
    if (!userSchemasMatch(localColumns, remoteColumns)) {
      drifted.push(tableName);
    }
  }
  return drifted;
}

