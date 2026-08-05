/**
 * Core table-copy logic for app-linked job data.db ↔ Turso boundary sync.
 * One Turso database per linked job (mirrors local data.db layout).
 * Uses Turso HTTP API (no embedded replica sync — deprecated on Turso cloud).
 */

import { createClient, type Client, type InArgs } from "@libsql/client";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { JOB_BASELINE_TABLES } from "./appDataSources.js";
import {
  migrateRemoteTableSchemaFromColumns,
} from "./tursoSchemaMigration.js";
import {
  computeSyncableTableFingerprints,
  computeSyncableTableFingerprintsForPath,
} from "./tursoTableFingerprint.js";
import {
  jobTursoDatabaseName,
  LEGACY_USER_TURSO_DATABASE,
} from "./tursoDatabaseNaming.js";
import { SYNC_INFRA_TABLES } from "./tursoSyncLog.js";
import {
  compactRemoteSyncLog,
  ensureLocalSyncInfrastructure,
  ensureLocalTableSyncTriggers,
  ensureRemoteSyncInfrastructure,
  ensureRemoteTableSyncTriggers,
  maxSyncLogId,
  mirrorSyncLogToRemote,
  pruneSyncLogThrough,
  readRemoteCompactedThroughId,
  readRemoteMaxSyncLogId,
  readRemoteSyncLogSince,
  readSyncLogSince,
  remoteSyncLogExists,
  withSyncMuted,
  withSyncMutedAsync,
} from "./tursoSyncLog.js";
import {
  applyRemoteSyncLogToLocal,
  localRemoteSchemaDriftTables,
  prepareRemoteTableForSync,
  pushDeltaToRemote,
  remoteNeedsBootstrap,
  remoteMissingLocalTables,
} from "./tursoDeltaSync.js";
import { ensureRemoteRowSyncColumns } from "./rowSyncColumns.js";

export interface TursoCredentials {
  tursoUrl: string;
  authToken: string;
}

export interface TableColumn {
  name: string;
  type: string;
  primaryKey: boolean;
}

export interface LocalTable {
  name: string;
  columns: TableColumn[];
  rows: unknown[][];
}

export type TursoSyncMode = "delta" | "bootstrap" | "snapshot_fallback" | "full";

export interface PushResult {
  status: "pushed" | "skipped";
  tables: string[];
  reason?: string;
  /** Fingerprints for all syncable local tables after push evaluation. */
  tableFingerprints?: Record<string, string>;
  skippedTables?: string[];
  /** Remote _papr_sync_meta version after this push (when pushed). */
  remoteVersion?: number;
  /** Highest local _papr_sync_log id included in this push. */
  lastPushedLogId?: number;
  /** Remote _papr_sync_log MAX(id) after this push. Record as lastPulledLogId
   * so our own mirrored entries aren't detected as "remote ahead" (self-echo). */
  remoteLogMaxId?: number;
  /** Changelog entries applied (delta mode). */
  deltaEntries?: number;
  syncMode?: TursoSyncMode;
}

export interface PullResult {
  status: "pulled" | "skipped";
  reason?: string;
  /** Remote _papr_sync_meta version observed during this pull. */
  remoteVersion?: number;
  /** Highest remote _papr_sync_log id applied locally. */
  lastPulledLogId?: number;
  deltaEntries?: number;
  syncMode?: TursoSyncMode;
}

export interface LinkedSourceSyncOptions {
  jobId: string;
  /** Fingerprints from the last successful push — skip unchanged tables. */
  previousFingerprints?: Record<string, string>;
  /** Force full push/pull even when fingerprints match. */
  force?: boolean;
  /** Last local _papr_sync_log id successfully pushed to Turso. */
  lastPushedLogId?: number;
  /** Last remote _papr_sync_log id successfully pulled to local. */
  lastPulledLogId?: number;
  /** When set, only sync these tables (schema + row deltas). */
  tableNames?: readonly string[];
}

export interface PullSourceSyncOptions extends LinkedSourceSyncOptions {
  /**
   * Remote version seen at last successful sync. When set and the remote
   * _papr_sync_meta version still matches, the pull is skipped after a
   * single-row read instead of re-reading every table.
   */
  lastSeenRemoteVersion?: number;
  /** Pull only when the local DB has no syncable user tables yet. */
  onlyIfLocalEmpty?: boolean;
  /** Skip pull when local data differs from last push (local wins). */
  skipIfLocalDirty?: boolean;
}

/** @deprecated Legacy shared user DB — use jobTursoDatabaseName(jobId) instead. */
export const USER_TURSO_DATABASE = LEGACY_USER_TURSO_DATABASE;

export { jobTursoDatabaseName, LEGACY_USER_TURSO_DATABASE };

/** @deprecated Use jobTursoDatabaseName(jobId) for per-job databases. */
export function userDatabaseName(): string {
  return LEGACY_USER_TURSO_DATABASE;
}

/** @deprecated Per-job DBs use unprefixed table names. Kept for legacy migration reads. */
export function tursoTablePrefix(jobId: string): string {
  return `src_${jobId}__`;
}

export const SYNC_REGISTRY_TABLE = "_papr_sync";

/**
 * Remote-only version counter, bumped on every successful push. Lets pulls
 * check freshness with a single-row read instead of reading every table
 * (the guardrail against runaway Turso read billing).
 */
export const SYNC_META_TABLE = "_papr_sync_meta";

export function isScratchTable(tableName: string): boolean {
  return (
    JOB_BASELINE_TABLES.has(tableName) ||
    tableName === SYNC_REGISTRY_TABLE ||
    tableName === SYNC_META_TABLE ||
    tableName === "_papr_schema_migrations" ||
    SYNC_INFRA_TABLES.has(tableName)
  );
}

export function filterSyncableTables(tableNames: readonly string[]): string[] {
  return tableNames.filter((name) => !isScratchTable(name));
}

/** Per-job Turso DB uses the same table names as local data.db. */
export function toRemoteTableName(localName: string, _jobId: string): string {
  return localName;
}

export function toLocalTableName(
  remoteName: string,
  _jobId: string,
): string | null {
  if (isScratchTable(remoteName)) {
    return null;
  }
  return remoteName;
}

export function isTursoDatabaseLimitError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("maximum database count") ||
    lower.includes("database limit reached") ||
    lower.includes("blocked from creating") ||
    lower.includes("enable overages") ||
    lower.includes("status\":429") ||
    lower.includes("status\": 429")
  );
}

/** Turso/memory-server provisioning overload (many concurrent token requests). */
export function isTursoProvisioningRateLimitError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("403 forbidden") ||
    lower.includes("database provisioning failed") ||
    lower.includes("provisioning failed") ||
    (lower.includes("turso token request failed (500)") &&
      lower.includes("403"))
  );
}

/** Local job SQLite is corrupt or unreadable — skip Turso sync until repaired. */
export function isTursoLocalDatabaseCorruptError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("database disk image is malformed") ||
    lower.includes("file is not a database") ||
    lower.includes("sqlite_corrupt") ||
    lower.includes("database corruption")
  );
}

/** Type mismatch during bind (often corrupt schema / bad row data). */
export function isTursoSqliteBindTypeError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("sqlite3 can only bind numbers");
}

export function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

export function listUserTables(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE 'libsql_%'`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

export function readTableSchema(
  db: Database.Database,
  tableName: string,
): TableColumn[] {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`).all() as Array<{
    name: string;
    type: string;
    pk: number;
  }>;
  return rows.map((row) => ({
    name: row.name,
    type: row.type || "TEXT",
    primaryKey: row.pk > 0,
  }));
}

export function readLocalTable(
  db: Database.Database,
  tableName: string,
): LocalTable {
  const columns = readTableSchema(db, tableName);
  if (columns.length === 0) {
    return { name: tableName, columns: [], rows: [] };
  }
  const colList = columns.map((col) => quoteIdent(col.name)).join(", ");
  const rows = db
    .prepare(`SELECT ${colList} FROM ${quoteIdent(tableName)}`)
    .raw()
    .all() as unknown[][];
  return { name: tableName, columns, rows };
}

export function buildCreateTableSql(table: LocalTable): string {
  const pkCols = table.columns.filter((col) => col.primaryKey);
  const colDefs = table.columns
    .map((col) => {
      const type = col.type.trim() || "TEXT";
      // Single-column PK inline; composite PK uses table-level constraint below.
      const pk = pkCols.length === 1 && col.primaryKey ? " PRIMARY KEY" : "";
      return `${quoteIdent(col.name)} ${type}${pk}`;
    })
    .join(", ");
  const compositePk =
    pkCols.length > 1
      ? `, PRIMARY KEY (${pkCols.map((col) => quoteIdent(col.name)).join(", ")})`
      : "";
  return `CREATE TABLE ${quoteIdent(table.name)} (${colDefs}${compositePk})`;
}

/** Parent tables before children (uses FK refs when present). */
export function sortTablesForInsert(
  tables: LocalTable[],
  foreignKeyRefs: ReadonlyMap<string, readonly string[]>,
): LocalTable[] {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const sorted: LocalTable[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) return;
    visiting.add(name);
    for (const dep of foreignKeyRefs.get(name) ?? []) {
      if (byName.has(dep)) visit(dep);
    }
    visiting.delete(name);
    visited.add(name);
    const table = byName.get(name);
    if (table) sorted.push(table);
  };

  for (const table of tables) {
    visit(table.name);
  }
  return sorted;
}

async function readRemoteForeignKeyRefs(
  remote: Client,
  remoteTableName: string,
  jobId: string,
  knownLocalNames: ReadonlySet<string>,
): Promise<string[]> {
  const result = await remote.execute(
    `PRAGMA foreign_key_list(${quoteIdent(remoteTableName)})`,
  );
  return result.rows
    .map((row) => {
      const refTable = String(row.table ?? "");
      const local =
        toLocalTableName(refTable, jobId) ??
        (knownLocalNames.has(refTable) ? refTable : null);
      return local;
    })
    .filter((name): name is string => name !== null && knownLocalNames.has(name));
}

function writeTablesToLocalDb(
  localDb: Database.Database,
  tables: LocalTable[],
): void {
  const writable = tables.filter((table) => table.columns.length > 0);
  if (writable.length === 0) {
    return;
  }

  localDb.pragma("foreign_keys = OFF");
  try {
    for (const table of writable) {
      localDb.exec(`DROP TABLE IF EXISTS ${quoteIdent(table.name)}`);
    }
    for (const table of writable) {
      localDb.exec(buildCreateTableSql(table));
    }
    for (const table of writable) {
      if (table.rows.length === 0) {
        continue;
      }
      const placeholders = table.columns.map(() => "?").join(", ");
      const colNames = table.columns.map((col) => quoteIdent(col.name)).join(", ");
      const insert = localDb.prepare(
        `INSERT INTO ${quoteIdent(table.name)} (${colNames}) VALUES (${placeholders})`,
      );
      for (const row of table.rows) {
        insert.run(...row);
      }
    }
  } finally {
    localDb.pragma("foreign_keys = ON");
  }
}

export function createRemoteClient(credentials: TursoCredentials): Client {
  return createClient({
    url: credentials.tursoUrl,
    authToken: credentials.authToken,
  });
}

async function listRemoteUserTables(remote: Client): Promise<string[]> {
  const result = await remote.execute(
    `SELECT name FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
       AND name NOT LIKE 'libsql_%'`,
  );
  return result.rows
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string");
}

export async function readRemoteTableSchema(
  remote: Client,
  tableName: string,
): Promise<TableColumn[]> {
  const result = await remote.execute(`PRAGMA table_info(${quoteIdent(tableName)})`);
  return result.rows.map((row) => ({
    name: String(row.name ?? ""),
    type: String(row.type ?? "TEXT"),
    primaryKey: Number(row.pk ?? 0) > 0,
  }));
}

async function readRemoteTable(
  remote: Client,
  tableName: string,
): Promise<LocalTable> {
  const columns = await readRemoteTableSchema(remote, tableName);
  if (columns.length === 0) {
    return { name: tableName, columns: [], rows: [] };
  }
  const colList = columns.map((col) => quoteIdent(col.name)).join(", ");
  const result = await remote.execute(
    `SELECT ${colList} FROM ${quoteIdent(tableName)}`,
  );
  const rows = result.rows.map((row) =>
    columns.map((col) => row[col.name] ?? null),
  );
  return { name: tableName, columns, rows };
}

async function remoteTableExists(
  remote: Client,
  tableName: string,
): Promise<boolean> {
  const result = await remote.execute({
    sql: `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
    args: [tableName],
  });
  return result.rows.length > 0;
}

export async function replaceRemoteTable(
  remote: Client,
  table: LocalTable,
): Promise<void> {
  await remote.execute(`DROP TABLE IF EXISTS ${quoteIdent(table.name)}`);
  await remote.execute(buildCreateTableSql(table));
  if (table.rows.length === 0) {
    return;
  }
  const placeholders = table.columns.map(() => "?").join(", ");
  const colNames = table.columns.map((col) => quoteIdent(col.name)).join(", ");
  const sql = `INSERT INTO ${quoteIdent(table.name)} (${colNames}) VALUES (${placeholders})`;
  const statements = table.rows.map((row) => ({
    sql,
    args: row as (string | number | bigint | null | Uint8Array)[],
  }));
  await remote.batch(statements, "write");
}

async function deleteRemoteRowsNotInLocalPks(
  remote: Client,
  tableName: string,
  pkColumn: string,
  localPks: unknown[],
): Promise<void> {
  if (localPks.length === 0) {
    await remote.execute(`DELETE FROM ${quoteIdent(tableName)}`);
    return;
  }

  const placeholders = localPks.map(() => "?").join(", ");
  await remote.execute({
    sql: `DELETE FROM ${quoteIdent(tableName)} WHERE ${quoteIdent(pkColumn)} NOT IN (${placeholders})`,
    args: localPks as InArgs,
  });
}

async function upsertRemoteTableIncremental(
  remote: Client,
  table: LocalTable,
): Promise<"incremental" | "replaced"> {
  const pkCols = table.columns.filter((col) => col.primaryKey);
  const exists = await remoteTableExists(remote, table.name);

  if (!exists) {
    await remote.execute(buildCreateTableSql(table));
    if (table.rows.length > 0) {
      const placeholders = table.columns.map(() => "?").join(", ");
      const colNames = table.columns.map((col) => quoteIdent(col.name)).join(", ");
      const sql = `INSERT INTO ${quoteIdent(table.name)} (${colNames}) VALUES (${placeholders})`;
      await remote.batch(
        table.rows.map((row) => ({
          sql,
          args: row as (string | number | bigint | null | Uint8Array)[],
        })),
        "write",
      );
    }
    return "incremental";
  }

  const result = await migrateRemoteTableSchemaFromColumns(
    remote,
    table.name,
    table.columns,
    async () => {
      await replaceRemoteTable(remote, table);
    },
  );
  if (result === "rebuilt") {
    return "replaced";
  }

  await ensureRemoteRowSyncColumns(remote, table.name);

  if (pkCols.length === 0) {
    await replaceRemoteTable(remote, table);
    return "replaced";
  }

  const placeholders = table.columns.map(() => "?").join(", ");
  const colNames = table.columns.map((col) => quoteIdent(col.name)).join(", ");
  const upsertSql = `INSERT OR REPLACE INTO ${quoteIdent(table.name)} (${colNames}) VALUES (${placeholders})`;

  if (table.rows.length > 0) {
    await remote.batch(
      table.rows.map((row) => ({
        sql: upsertSql,
        args: row as (string | number | bigint | null | Uint8Array)[],
      })),
      "write",
    );
  }

  if (pkCols.length === 1) {
    const pkIndex = table.columns.findIndex((col) => col.name === pkCols[0]!.name);
    const localPks = table.rows.map((row) => row[pkIndex]);
    if (localPks.length <= 2_000) {
      await deleteRemoteRowsNotInLocalPks(
        remote,
        table.name,
        pkCols[0]!.name,
        localPks,
      );
      return "incremental";
    }
  }

  await replaceRemoteTable(remote, table);
  return "replaced";
}

export async function syncTablesToRemote(
  remote: Client,
  tables: LocalTable[],
): Promise<string[]> {
  const synced: string[] = [];
  for (const table of tables) {
    if (table.columns.length === 0) {
      continue;
    }
    await upsertRemoteTableIncremental(remote, table);
    synced.push(table.name);
  }
  return synced;
}

export async function dropRemoteTablesForJob(
  credentials: TursoCredentials,
  _jobId: string,
  options?: { keepTables?: ReadonlySet<string> },
): Promise<string[]> {
  const remote = createRemoteClient(credentials);
  const dropped: string[] = [];
  try {
    const remoteTables = filterSyncableTables(await listRemoteUserTables(remote));
    for (const remoteName of remoteTables) {
      if (options?.keepTables?.has(remoteName)) {
        continue;
      }
      await remote.execute(`DROP TABLE IF EXISTS ${quoteIdent(remoteName)}`);
      dropped.push(remoteName);
    }
  } finally {
    remote.close();
  }
  return dropped;
}

/** Exported for unit tests — applies pulled Turso tables to a local job DB. */
export function applyPulledTablesToLocalDb(
  localDb: Database.Database,
  tables: LocalTable[],
): void {
  writeTablesToLocalDb(localDb, tables);
}

function cleanupSqliteSidecars(dbPath: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      // ignore
    }
  }
}

function requireLinkedSourceOptions(
  options: LinkedSourceSyncOptions | undefined,
): LinkedSourceSyncOptions {
  if (!options?.jobId) {
    throw new Error("Linked source sync requires jobId");
  }
  return options;
}

function tablesToSync(
  tableNames: string[],
  currentFingerprints: Record<string, string>,
  previousFingerprints: Record<string, string> | undefined,
  force: boolean,
): { changed: string[]; skipped: string[] } {
  if (force || !previousFingerprints) {
    return { changed: tableNames, skipped: [] };
  }
  const changed: string[] = [];
  const skipped: string[] = [];
  for (const name of tableNames) {
    if (currentFingerprints[name] === previousFingerprints[name]) {
      skipped.push(name);
    } else {
      changed.push(name);
    }
  }
  return { changed, skipped };
}

/** Read the remote sync version with a single-row query. Null when absent. */
export async function readRemoteSyncVersion(remote: Client): Promise<number | null> {
  try {
    const result = await remote.execute(
      `SELECT version FROM ${quoteIdent(SYNC_META_TABLE)} WHERE id = 1`,
    );
    const value = result.rows[0]?.["version"];
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null; // table doesn't exist yet (pre-versioning database)
  }
}

/** True when remote has changelog entries or version ahead of last seen local state.
 *
 * INVARIANT: the changelog check below must run even when the version check
 * is inconclusive. bumpRemoteSyncVersion is best-effort (host writes never
 * fail over the counter), so the version can be stale — the remote
 * _papr_sync_log (populated by CDC triggers on host/cloud writes) is the
 * authoritative signal. Do not short-circuit it away. */
export async function remoteAheadOfLocal(
  remote: Client,
  options: {
    lastSeenRemoteVersion?: number;
    lastPulledLogId?: number;
  },
): Promise<boolean> {
  const remoteVersion = (await readRemoteSyncVersion(remote)) ?? undefined;
  if (
    remoteVersion !== undefined &&
    options.lastSeenRemoteVersion !== undefined &&
    remoteVersion > options.lastSeenRemoteVersion
  ) {
    return true;
  }

  const hasRemoteLog = await remoteSyncLogExists(remote);
  if (!hasRemoteLog) {
    return false;
  }

  const lastPulledLogId = options.lastPulledLogId ?? 0;
  const remoteEntries = await readRemoteSyncLogSince(remote, lastPulledLogId);
  return remoteEntries.length > 0;
}

/** Bump the remote sync version after a successful push (or any host-side
 * write) so other devices' version-checked pulls see the change; returns new version. */
export async function bumpRemoteSyncVersion(remote: Client): Promise<number | undefined> {
  try {
    await remote.execute(
      `CREATE TABLE IF NOT EXISTS ${quoteIdent(SYNC_META_TABLE)} ` +
        `(id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL DEFAULT 0, updated_at TEXT)`,
    );
    await remote.execute(
      `INSERT INTO ${quoteIdent(SYNC_META_TABLE)} (id, version, updated_at) ` +
        `VALUES (1, 1, datetime('now')) ` +
        `ON CONFLICT(id) DO UPDATE SET version = version + 1, updated_at = datetime('now')`,
    );
    const version = await readRemoteSyncVersion(remote);
    return version ?? undefined;
  } catch {
    return undefined; // best-effort — never fail a push over the counter
  }
}

export async function pushLocalDbToTurso(
  localDbPath: string,
  credentials: TursoCredentials,
  options?: LinkedSourceSyncOptions,
): Promise<PushResult> {
  const syncOptions = requireLinkedSourceOptions(options);

  if (!fs.existsSync(localDbPath)) {
    return { status: "skipped", tables: [], reason: "local_db_missing" };
  }

  const stats = fs.statSync(localDbPath);
  if (stats.size === 0) {
    return { status: "skipped", tables: [], reason: "local_db_empty" };
  }

  const localDb = openWritableLocalJobDb(localDbPath);
  const remote = createRemoteClient(credentials);
  try {
    localDb.pragma("wal_checkpoint(TRUNCATE)");
    ensureLocalSyncInfrastructure(localDb);

    const allTableNames = filterSyncableTables(listUserTables(localDb));
    const tableFilter = syncOptions.tableNames?.length
      ? new Set(syncOptions.tableNames)
      : null;
    const tableNames = tableFilter
      ? allTableNames.filter((name) => tableFilter.has(name))
      : allTableNames;
    if (tableNames.length === 0) {
      return {
        status: "skipped",
        tables: [],
        reason: tableFilter ? "no_matching_tables" : "no_syncable_tables",
      };
    }

    for (const tableName of tableNames) {
      ensureLocalTableSyncTriggers(localDb, tableName);
    }

    const currentFingerprints = computeSyncableTableFingerprints(localDb);
    const { changed, skipped } = tablesToSync(
      tableNames,
      currentFingerprints,
      syncOptions.previousFingerprints,
      syncOptions.force === true,
    );

    const lastPushedLogId = syncOptions.lastPushedLogId ?? 0;
    const pendingEntries = readSyncLogSince(localDb, lastPushedLogId).filter(
      (entry) => !tableFilter || tableFilter.has(entry.tableName),
    );
    const missingOnRemote = await remoteMissingLocalTables(remote, tableNames);
    const bootstrap =
      syncOptions.force === true ||
      (await remoteNeedsBootstrap(remote)) ||
      missingOnRemote.length > 0;

    if (missingOnRemote.length > 0 && !syncOptions.force) {
      console.warn(
        `[TursoSync] Remote missing ${missingOnRemote.length} local table(s) for ${syncOptions.jobId}: ` +
          `${missingOnRemote.join(", ")} — forcing bootstrap`,
      );
    }

    if (bootstrap) {
      const syncedRemote = await syncTablesToRemote(
        remote,
        tableNames.map((name) => readLocalTable(localDb, name)),
      );
      await ensureRemoteSyncInfrastructure(remote);
      for (const tableName of tableNames) {
        const columns = readTableSchema(localDb, tableName);
        await ensureRemoteTableSyncTriggers(remote, columns, tableName);
      }
      const maxId = maxSyncLogId(localDb);
      pruneSyncLogThrough(localDb, maxId);
      const remoteVersion = await bumpRemoteSyncVersion(remote);
      // Bootstrap replaced remote tables wholesale — any pre-existing remote
      // log entries are now redundant; mark them as pulled.
      const remoteLogMaxId = await readRemoteMaxSyncLogId(remote);
      // Full replace invalidates the old changelog for everyone: compact it
      // immediately (no threshold/retention) and set compacted_through_id so
      // stale consumers full-resync instead of delta-pulling a broken history.
      if (remoteLogMaxId !== undefined && remoteLogMaxId > 0) {
        await compactRemoteSyncLog(remote, remoteLogMaxId, {
          minEntries: 1,
          retentionDays: 0,
        });
      }
      return {
        status: "pushed",
        tables: syncedRemote,
        tableFingerprints: currentFingerprints,
        skippedTables: skipped,
        remoteVersion,
        lastPushedLogId: maxId,
        ...(remoteLogMaxId !== undefined ? { remoteLogMaxId } : {}),
        syncMode: "bootstrap",
      };
    }

    if (pendingEntries.length === 0 && changed.length === 0) {
      return {
        status: "skipped",
        tables: [],
        reason: "all_tables_unchanged",
        tableFingerprints: currentFingerprints,
        skippedTables: skipped,
      };
    }

    // DDL (ADD COLUMN, etc.) does not appear in the row changelog — migrate any
    // table whose local schema differs from Turso before delta or snapshot push.
    const schemaDriftTables = await localRemoteSchemaDriftTables(
      remote,
      localDb,
      tableNames,
    );
    const tablesNeedingSchema = [
      ...new Set([...changed, ...schemaDriftTables]),
    ];
    if (tablesNeedingSchema.length > 0) {
      await ensureRemoteSyncInfrastructure(remote);
      for (const tableName of tablesNeedingSchema) {
        await prepareRemoteTableForSync(remote, localDb, tableName);
      }
    }

    if (pendingEntries.length > 0) {
      await ensureRemoteSyncInfrastructure(remote);
      const touched = await pushDeltaToRemote(localDb, remote, pendingEntries);
      const remoteLogMaxId = await mirrorSyncLogToRemote(remote, pendingEntries);
      const maxId = pendingEntries[pendingEntries.length - 1]!.id;
      pruneSyncLogThrough(localDb, maxId);
      const remoteVersion = await bumpRemoteSyncVersion(remote);
      // Opportunistic remote log compaction. Watermark = remoteLogMaxId: this
      // consumer has seen everything up to it (remote-ahead was merged before
      // push and our own entries were just mirrored). Threshold + retention
      // floor inside protect other/untracked consumers.
      if (remoteLogMaxId !== undefined && remoteLogMaxId > 0) {
        await compactRemoteSyncLog(remote, remoteLogMaxId);
      }
      return {
        status: "pushed",
        tables: touched,
        tableFingerprints: currentFingerprints,
        skippedTables: skipped,
        remoteVersion,
        lastPushedLogId: maxId,
        ...(remoteLogMaxId !== undefined ? { remoteLogMaxId } : {}),
        deltaEntries: pendingEntries.length,
        syncMode: "delta",
      };
    }

    // Changelog empty but fingerprints show local changes (e.g. agent writes
    // before sync triggers were installed). Push all changed tables directly.
    await ensureRemoteSyncInfrastructure(remote);
    const snapshotTables =
      tablesNeedingSchema.length > 0 ? tablesNeedingSchema : changed;
    const syncedRemote = await syncTablesToRemote(
      remote,
      snapshotTables.map((name) => readLocalTable(localDb, name)),
    );
    for (const tableName of snapshotTables) {
      const columns = readTableSchema(localDb, tableName);
      await ensureRemoteTableSyncTriggers(remote, columns, tableName);
    }
    const remoteVersion = await bumpRemoteSyncVersion(remote);
    return {
      status: "pushed",
      tables: syncedRemote,
      tableFingerprints: currentFingerprints,
      skippedTables: skipped,
      remoteVersion,
      syncMode: "snapshot_fallback",
    };
  } finally {
    localDb.close();
    remote.close();
  }
}

const LOCAL_DB_BUSY_TIMEOUT_MS = 5_000;

/** Paths where changelog infrastructure was installed this session (avoids DDL on every watcher event). */
const changeLogReadyPaths = new Set<string>();

export function isSqliteBusyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "SQLITE_BUSY"
  );
}

/** @internal test hook */
export function resetChangeLogReadyCacheForTests(): void {
  changeLogReadyPaths.clear();
}

export function openWritableLocalJobDb(localDbPath: string): Database.Database {
  const db = new Database(localDbPath);
  db.pragma("journal_mode = WAL");
  db.pragma(`busy_timeout = ${LOCAL_DB_BUSY_TIMEOUT_MS}`);
  return db;
}

/** Install changelog infrastructure + triggers on a linked job DB (idempotent). */
export function ensureLocalDbChangeLogReady(localDbPath: string): void {
  const normalized = path.normalize(localDbPath);
  if (changeLogReadyPaths.has(normalized)) {
    return;
  }
  if (!fs.existsSync(normalized)) {
    return;
  }
  const stats = fs.statSync(normalized);
  if (stats.size === 0) {
    return;
  }
  const localDb = openWritableLocalJobDb(normalized);
  try {
    ensureLocalSyncInfrastructure(localDb);
    for (const tableName of filterSyncableTables(listUserTables(localDb))) {
      ensureLocalTableSyncTriggers(localDb, tableName);
    }
    changeLogReadyPaths.add(normalized);
  } finally {
    localDb.close();
  }
}

export async function pullTursoToLocalDb(
  localDbPath: string,
  credentials: TursoCredentials,
  options?: PullSourceSyncOptions,
): Promise<PullResult> {
  const syncOptions = requireLinkedSourceOptions(options);

  const dataDir = path.dirname(localDbPath);
  fs.mkdirSync(dataDir, { recursive: true });

  if (options?.onlyIfLocalEmpty && fs.existsSync(localDbPath)) {
    const stats = fs.statSync(localDbPath);
    if (stats.size > 0) {
      const fingerprints = computeSyncableTableFingerprintsForPath(localDbPath);
      if (fingerprints && Object.keys(fingerprints).length > 0) {
        return { status: "skipped", reason: "local_db_has_data" };
      }
    }
  }

  if (options?.skipIfLocalDirty && fs.existsSync(localDbPath)) {
    const { isJobDbDirty, loadTursoSyncState } = await import("./tursoSyncState.js");
    const state = loadTursoSyncState();
    if (isJobDbDirty(syncOptions.jobId, localDbPath, state)) {
      return { status: "skipped", reason: "local_db_dirty" };
    }
  }

  if (!fs.existsSync(localDbPath)) {
    fs.writeFileSync(localDbPath, "");
  }
  cleanupSqliteSidecars(localDbPath);

  const remote = createRemoteClient(credentials);
  let localDb: Database.Database | null = null;
  try {
    const remoteVersion = (await readRemoteSyncVersion(remote)) ?? undefined;
    const lastPulledLogId = syncOptions.lastPulledLogId ?? 0;
    const hasRemoteLog = await remoteSyncLogExists(remote);

    // Stale-consumer escape hatch: if compaction deleted entries we never
    // pulled (lastPulledLogId < compacted_through_id), the delta history is
    // incomplete for us — fall through to a full pull instead.
    let staleConsumer = false;
    if (hasRemoteLog && !syncOptions.force) {
      const compactedThrough = await readRemoteCompactedThroughId(remote);
      staleConsumer = lastPulledLogId < compactedThrough;
    }

    if (hasRemoteLog && !syncOptions.force && !staleConsumer) {
      const remoteEntries = await readRemoteSyncLogSince(remote, lastPulledLogId);
      if (remoteEntries.length > 0) {
        localDb = openWritableLocalJobDb(localDbPath);
        ensureLocalSyncInfrastructure(localDb);
        for (const tableName of filterSyncableTables(listUserTables(localDb))) {
          ensureLocalTableSyncTriggers(localDb, tableName);
        }
        await withSyncMutedAsync(localDb, async () => {
          await applyRemoteSyncLogToLocal(localDb!, remote, remoteEntries);
        });
        localDb.pragma("wal_checkpoint(TRUNCATE)");
        const maxId = remoteEntries[remoteEntries.length - 1]!.id;
        return {
          status: "pulled",
          remoteVersion,
          lastPulledLogId: maxId,
          deltaEntries: remoteEntries.length,
          syncMode: "delta",
        };
      }
    }

    // Version check: skip full-table read when remote version unchanged and no pending changelog.
    if (
      !syncOptions.force &&
      !staleConsumer &&
      remoteVersion !== undefined &&
      options?.lastSeenRemoteVersion !== undefined &&
      remoteVersion === options.lastSeenRemoteVersion &&
      fs.existsSync(localDbPath) &&
      fs.statSync(localDbPath).size > 0
    ) {
      return { status: "skipped", reason: "remote_unchanged", remoteVersion };
    }

    // Read the remote log watermark BEFORE reading tables: entries created
    // after this point are either already in the tables we read or will be
    // picked up by the next delta pull. Recording it as lastPulledLogId keeps
    // the delta cursor valid after a full pull (previously it stayed stale).
    const fullPullLogWatermark = hasRemoteLog
      ? await readRemoteMaxSyncLogId(remote)
      : undefined;

    const tableNames = filterSyncableTables(await listRemoteUserTables(remote));
    if (tableNames.length === 0) {
      return { status: "skipped", reason: "no_remote_tables", remoteVersion };
    }

    const tables: LocalTable[] = [];
    for (const tableName of tableNames) {
      const remoteTable = await readRemoteTable(remote, tableName);
      if (isScratchTable(tableName)) {
        continue;
      }
      tables.push({ ...remoteTable, name: tableName });
    }

    if (tables.length === 0) {
      return { status: "skipped", reason: "no_syncable_remote_tables", remoteVersion };
    }

    const knownLocalNames = new Set(tables.map((table) => table.name));
    const foreignKeyRefs = new Map<string, string[]>();
    for (const tableName of tableNames) {
      if (isScratchTable(tableName) || !knownLocalNames.has(tableName)) {
        continue;
      }
      const refs = await readRemoteForeignKeyRefs(
        remote,
        tableName,
        syncOptions.jobId,
        knownLocalNames,
      );
      foreignKeyRefs.set(tableName, refs);
    }
    const orderedTables = sortTablesForInsert(tables, foreignKeyRefs);

    localDb = openWritableLocalJobDb(localDbPath);
    withSyncMuted(localDb, () => {
      writeTablesToLocalDb(localDb!, orderedTables);
    });
    localDb.pragma("wal_checkpoint(TRUNCATE)");
    return {
      status: "pulled",
      remoteVersion,
      ...(fullPullLogWatermark !== undefined
        ? { lastPulledLogId: fullPullLogWatermark }
        : {}),
      syncMode: "full",
    };
  } finally {
    localDb?.close();
    remote.close();
  }
}
