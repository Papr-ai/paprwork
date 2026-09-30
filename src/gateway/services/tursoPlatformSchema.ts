/**
 * Central Turso platform table bootstrap — CREATE IF NOT EXISTS + legacy column ALTERs.
 *
 * Old replicas may have platform tables created before new columns were added.
 * CREATE IF NOT EXISTS alone does not upgrade them; run this on every remote touch.
 */

import type { Client } from "@libsql/client";
import { quoteIdent, SYNC_META_TABLE } from "./tursoSyncBridgeCore.js";
import { isDuplicateColumnError } from "./jobs/migrationSqlHelpers.js";

export const REMOTE_SCHEMA_MIGRATIONS_TABLE = "_papr_schema_migrations";
export const PLATFORM_SYNC_LOG_TABLE = "_papr_sync_log";
export const PLATFORM_SYNC_MUTE_TABLE = "_papr_sync_mute";
export const PLATFORM_SYNC_INFRA_TABLE = "_papr_sync_infra";

const MUTE_ROW_ID = 1;

async function remoteTableExists(
  remote: Client,
  tableName: string,
): Promise<boolean> {
  const result = await remote.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1",
    args: [tableName],
  });
  return result.rows.length > 0;
}

async function remoteTableHasColumn(
  remote: Client,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  if (!(await remoteTableExists(remote, tableName))) {
    return false;
  }
  const info = await remote.execute(
    `PRAGMA table_info(${quoteIdent(tableName)})`,
  );
  return info.rows.some((row) => String(row.name ?? "") === columnName);
}

async function addRemoteColumnIfMissing(
  remote: Client,
  tableName: string,
  columnName: string,
  columnDef: string,
): Promise<void> {
  if (await remoteTableHasColumn(remote, tableName, columnName)) {
    return;
  }
  try {
    await remote.execute(
      `ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN ${columnDef}`,
    );
  } catch (error) {
    if (!isDuplicateColumnError(error)) {
      throw error;
    }
  }
}

export async function ensureRemoteSchemaMigrationsTable(
  remote: Client,
): Promise<void> {
  await remote.execute(
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(REMOTE_SCHEMA_MIGRATIONS_TABLE)} (` +
      `id TEXT PRIMARY KEY, ` +
      `applied_at TEXT NOT NULL, ` +
      `source TEXT NOT NULL DEFAULT 'database_migration', ` +
      `content_hash TEXT` +
      `)`,
  );
  await addRemoteColumnIfMissing(
    remote,
    REMOTE_SCHEMA_MIGRATIONS_TABLE,
    "source",
    "source TEXT NOT NULL DEFAULT 'database_migration'",
  );
  await addRemoteColumnIfMissing(
    remote,
    REMOTE_SCHEMA_MIGRATIONS_TABLE,
    "content_hash",
    "content_hash TEXT",
  );
}

async function ensureRemoteSyncLogTable(remote: Client): Promise<void> {
  await remote.execute(
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(PLATFORM_SYNC_LOG_TABLE)} (` +
      `id INTEGER PRIMARY KEY AUTOINCREMENT, ` +
      `table_name TEXT NOT NULL, ` +
      `op TEXT NOT NULL CHECK (op IN ('insert', 'update', 'delete')), ` +
      `row_pk TEXT NOT NULL, ` +
      `changed_at TEXT NOT NULL DEFAULT (datetime('now'))` +
      `)`,
  );
  await addRemoteColumnIfMissing(
    remote,
    PLATFORM_SYNC_LOG_TABLE,
    "changed_at",
    "changed_at TEXT NOT NULL DEFAULT (datetime('now'))",
  );
}

async function ensureRemoteSyncMuteTable(remote: Client): Promise<void> {
  await remote.execute(
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(PLATFORM_SYNC_MUTE_TABLE)} (` +
      `id INTEGER PRIMARY KEY CHECK (id = ${MUTE_ROW_ID}), ` +
      `depth INTEGER NOT NULL DEFAULT 0` +
      `)`,
  );
  await remote.execute(
    `INSERT OR IGNORE INTO ${quoteIdent(PLATFORM_SYNC_MUTE_TABLE)} ` +
      `(id, depth) VALUES (${MUTE_ROW_ID}, 0)`,
  );
}

async function ensureRemoteSyncInfraTable(remote: Client): Promise<void> {
  await remote.execute(
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(PLATFORM_SYNC_INFRA_TABLE)} (` +
      `key TEXT PRIMARY KEY, value TEXT NOT NULL` +
      `)`,
  );
}

async function ensureRemoteSyncMetaTable(remote: Client): Promise<void> {
  await remote.execute(
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(SYNC_META_TABLE)} (` +
      `id INTEGER PRIMARY KEY CHECK (id = 1), ` +
      `version INTEGER NOT NULL DEFAULT 0, ` +
      `updated_at TEXT` +
      `)`,
  );
  await addRemoteColumnIfMissing(
    remote,
    SYNC_META_TABLE,
    "updated_at",
    "updated_at TEXT",
  );
  await addRemoteColumnIfMissing(
    remote,
    SYNC_META_TABLE,
    "compacted_through_id",
    "compacted_through_id INTEGER NOT NULL DEFAULT 0",
  );
  await remote.execute(
    `INSERT OR IGNORE INTO ${quoteIdent(SYNC_META_TABLE)} (id, version) VALUES (1, 0)`,
  );
}

/** Bootstrap all platform _papr_* tables on a Turso replica (idempotent). */
export async function ensureRemotePlatformTursoSchema(
  remote: Client,
): Promise<void> {
  await ensureRemoteSchemaMigrationsTable(remote);
  await ensureRemoteSyncLogTable(remote);
  await ensureRemoteSyncMuteTable(remote);
  await ensureRemoteSyncInfraTable(remote);
  await ensureRemoteSyncMetaTable(remote);
}
