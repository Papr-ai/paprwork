/**
 * Core table-copy logic for app-linked job data.db ↔ Turso boundary sync.
 * One Turso database per linked job (mirrors local data.db layout).
 * Uses Turso HTTP API (no embedded replica sync — deprecated on Turso cloud).
 */

import { createClient, type Client } from "@libsql/client";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { JOB_BASELINE_TABLES } from "./appDataSources.js";
import {
  migrateRemoteTableSchemaFromColumns,
} from "./tursoSchemaMigration.js";
import {
  jobTursoDatabaseName,
  LEGACY_USER_TURSO_DATABASE,
} from "./tursoDatabaseNaming.js";
import { isLegacyCdcArtifactTable } from "./legacyCdcArtifacts.js";
import { SYNC_INFRA_TABLES } from "./tursoSyncLog.js";
import {
  ensureLocalSyncInfrastructure,
  ensureLocalTableSyncTriggers,
  isLocalCdcMarkerSet,
  localInsertTriggerExists,
  markLocalCdcReady,
  mirrorSyncLogToRemote,
  readRemoteSyncLogSince,
  remoteSyncLogExists,
} from "./tursoSyncLog.js";
import {
  batchInsertLocalTableRows,
  deleteRemoteOrphanRowsByPk,
  REMOTE_READ_CHUNK_ROWS,
} from "./tursoBulkInsert.js";
import { batchUpsertLocalRows } from "./tursoLocalBulkWrite.js";
import { ensureRemoteRowSyncColumns } from "./rowSyncColumns.js";
import { assertNotReplicaManagedWritablePath, isReplicaManagedDbPath } from "./tursoReplica/tursoReplicaFileGuard.js";

function isReplicaManagedDbPathSync(dbPath: string): boolean {
  try {
    return isReplicaManagedDbPath(dbPath);
  } catch {
    return false;
  }
}

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
  /** Full CREATE TABLE from sqlite_master — preserves NOT NULL, DEFAULT, FK, etc. */
  createSql?: string;
}

export type TursoSyncMode =
  | "delta"
  | "bootstrap"
  | "snapshot_fallback"
  | "full"
  | "reconcile";

export interface PushResult {
  status: "pushed" | "skipped" | "failed";
  tables: string[];
  reason?: string;
  error?: string;
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
  syncMode?: TursoSyncMode | "replica";
}

export interface PullResult {
  status: "pulled" | "skipped" | "failed";
  reason?: string;
  error?: string;
  tables?: string[];
  /** Remote _papr_sync_meta version observed during this pull. */
  remoteVersion?: number;
  /** Highest remote _papr_sync_log id applied locally. */
  lastPulledLogId?: number;
  deltaEntries?: number;
  syncMode?: TursoSyncMode | "replica";
  /** Tables snapshot-pulled during post-delta fingerprint reconcile. */
  reconciledTables?: string[];
}

export interface LinkedSourceSyncOptions {
  jobId: string;
  /** Fingerprints from the last successful push — skip unchanged tables. */
  previousFingerprints?: Record<string, string>;
  /** Explicit repair bootstrap (empty remote retry) — not used for routine Upload now. */
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
  /**
   * Bidirectional merge pull: apply remote changelog with LWW while local has
   * unpushed edits. Skips bulk snapshot reconcile that would clobber local rows.
   */
  mergeWhileLocalDirty?: boolean;
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

/** SQLite FK recovery table — local-only artifact, never user sync data. */
export const SQLITE_RECOVERY_TABLE = "lost_and_found";

export function isScratchTable(tableName: string): boolean {
  return (
    JOB_BASELINE_TABLES.has(tableName) ||
    tableName === SYNC_REGISTRY_TABLE ||
    tableName === SYNC_META_TABLE ||
    tableName === "_papr_schema_migrations" ||
    tableName === SQLITE_RECOVERY_TABLE ||
    SYNC_INFRA_TABLES.has(tableName) ||
    isLegacyCdcArtifactTable(tableName)
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

export function readTableCreateSql(
  db: Database.Database,
  tableName: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
    )
    .get(tableName) as { sql: string | null } | undefined;
  const sql = row?.sql?.trim();
  return sql && sql.length > 0 ? sql : undefined;
}

export async function readRemoteTableCreateSql(
  remote: Client,
  tableName: string,
): Promise<string | undefined> {
  const result = await remote.execute({
    sql: `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
    args: [tableName],
  });
  const sql = String(result.rows[0]?.sql ?? "").trim();
  return sql.length > 0 ? sql : undefined;
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
  return {
    name: tableName,
    columns,
    rows,
    createSql: readTableCreateSql(db, tableName),
  };
}

export function buildCreateTableSql(table: LocalTable): string {
  if (table.createSql) {
    return table.createSql;
  }
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

/** FK parent tables referenced by columns in `tableNames`. */
export function readLocalForeignKeyRefs(
  db: Database.Database,
  tableNames: readonly string[],
): Map<string, string[]> {
  const knownNames = new Set(tableNames);
  const refs = new Map<string, string[]>();
  for (const name of tableNames) {
    const rows = db
      .prepare(`PRAGMA foreign_key_list(${quoteIdent(name)})`)
      .all() as Array<{ table: string }>;
    refs.set(
      name,
      rows
        .map((row) => row.table)
        .filter((table) => knownNames.has(table)),
    );
  }
  return refs;
}

/** Parent tables before children (table names only). */
export function sortTableNamesForInsert(
  tableNames: readonly string[],
  foreignKeyRefs: ReadonlyMap<string, readonly string[]>,
): string[] {
  const tables: LocalTable[] = tableNames.map((name) => ({
    name,
    columns: [{ name: "id", type: "INTEGER", primaryKey: true }],
    rows: [],
  }));
  return sortTablesForInsert(tables, foreignKeyRefs).map((table) => table.name);
}

/** Child tables before parents — safe order for DELETE batches. */
export function sortTableNamesForDelete(
  tableNames: readonly string[],
  foreignKeyRefs: ReadonlyMap<string, readonly string[]>,
): string[] {
  return [...sortTableNamesForInsert(tableNames, foreignKeyRefs)].reverse();
}

export function writeTablesToLocalDb(
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
      batchUpsertLocalRows(localDb, table.name, table.columns, table.rows);
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

export async function readRemoteTable(
  remote: Client,
  tableName: string,
): Promise<LocalTable> {
  const columns = await readRemoteTableSchema(remote, tableName);
  if (columns.length === 0) {
    return { name: tableName, columns: [], rows: [] };
  }
  const colList = columns.map((col) => quoteIdent(col.name)).join(", ");
  const rows: unknown[][] = [];
  let offset = 0;
  while (true) {
    const result = await remote.execute({
      sql:
        `SELECT ${colList} FROM ${quoteIdent(tableName)} ` +
        `LIMIT ? OFFSET ?`,
      args: [REMOTE_READ_CHUNK_ROWS, offset],
    });
    if (result.rows.length === 0) {
      break;
    }
    for (const row of result.rows) {
      rows.push(columns.map((col) => row[col.name] ?? null));
    }
    if (result.rows.length < REMOTE_READ_CHUNK_ROWS) {
      break;
    }
    offset += REMOTE_READ_CHUNK_ROWS;
  }
  const createSql = await readRemoteTableCreateSql(remote, tableName);
  return { name: tableName, columns, rows, createSql };
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
  await batchInsertLocalTableRows(
    remote,
    table.name,
    table.columns,
    table.rows,
    "insert",
  );
}

async function upsertRemoteTableIncremental(
  remote: Client,
  table: LocalTable,
): Promise<"incremental" | "replaced"> {
  const pkCols = table.columns.filter((col) => col.primaryKey);
  const exists = await remoteTableExists(remote, table.name);

  if (!exists) {
    await remote.execute(buildCreateTableSql(table));
    await batchInsertLocalTableRows(
      remote,
      table.name,
      table.columns,
      table.rows,
      "insert",
    );
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

  if (table.rows.length > 0) {
    await batchInsertLocalTableRows(
      remote,
      table.name,
      table.columns,
      table.rows,
      "upsert",
    );
  }

  if (pkCols.length === 1) {
    const pkIndex = table.columns.findIndex((col) => col.name === pkCols[0]!.name);
    const localPks = table.rows.map((row) => row[pkIndex]);
    const deletedPks = await deleteRemoteOrphanRowsByPk(
      remote,
      table.name,
      pkCols[0]!.name,
      localPks,
    );
    if (deletedPks.length > 0) {
      await mirrorSyncLogToRemote(
        remote,
        deletedPks.map((pk) => ({
          id: 0,
          tableName: table.name,
          op: "delete" as const,
          rowPk: [pk],
        })),
      );
    }
    return "incremental";
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

/**
 * Fold the WAL back into the main DB file, then drop the sidecars.
 *
 * NEVER unlink a non-empty `-wal` directly: it contains committed pages that are
 * not yet in the main file, so deleting it silently discards data AND leaves
 * readers hitting SQLITE_IOERR ("disk I/O error") because `-shm` is gone. In a
 * mini-app that surfaces as an empty list — indistinguishable from data loss.
 *
 * A TRUNCATE checkpoint writes every WAL page into the main file and removes the
 * sidecars itself, which is the safe way to reach the same "no sidecars" state.
 * If another process holds the DB we leave the sidecars alone rather than
 * corrupting them — a live `-wal` is always safer than a deleted one.
 */
function cleanupSqliteSidecars(dbPath: string): void {
  const walPath = dbPath + "-wal";
  let walSize = 0;
  try {
    walSize = fs.statSync(walPath).size;
  } catch {
    walSize = 0;
  }

  if (walSize > 0) {
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath);
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // DB locked or unreadable — keep sidecars intact; deleting them here is
      // what previously destroyed committed rows.
      return;
    } finally {
      try {
        db?.close();
      } catch {
        /* already closed */
      }
    }

    // Checkpoint failed to drain the WAL (concurrent reader) — leave it alone.
    try {
      if (fs.statSync(walPath).size > 0) return;
    } catch {
      /* wal already gone — checkpoint removed it */
    }
  }

  for (const suffix of ["-wal", "-shm"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      // ignore
    }
  }
}

/** Snapshot local job DB (+ WAL sidecars) before a mutating sync step. */
export interface LocalJobDbBackup {
  basePath: string;
}

export function backupLocalJobDb(dbPath: string): LocalJobDbBackup {
  const normalized = path.normalize(dbPath);
  const basePath = `${normalized}.sync-backup-${Date.now()}`;
  fs.copyFileSync(normalized, basePath);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = normalized + suffix;
    if (fs.existsSync(sidecar)) {
      fs.copyFileSync(sidecar, basePath + suffix);
    }
  }
  return { basePath };
}

export function restoreLocalJobDb(dbPath: string, backup: LocalJobDbBackup): void {
  const normalized = path.normalize(dbPath);
  fs.copyFileSync(backup.basePath, normalized);
  for (const suffix of ["-wal", "-shm"]) {
    const backupSidecar = backup.basePath + suffix;
    const targetSidecar = normalized + suffix;
    if (fs.existsSync(backupSidecar)) {
      fs.copyFileSync(backupSidecar, targetSidecar);
    } else {
      try {
        fs.unlinkSync(targetSidecar);
      } catch {
        /* optional sidecar */
      }
    }
  }
}

export function removeLocalJobDbBackup(backup: LocalJobDbBackup): void {
  for (const filePath of [
    backup.basePath,
    backup.basePath + "-wal",
    backup.basePath + "-shm",
  ]) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* already removed */
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

function buildLinkedSourceForSync(
  localDbPath: string,
  syncOptions: LinkedSourceSyncOptions,
): import("./tursoLinkedSources.js").TursoLinkedSource {
  return {
    appId: "standalone",
    jobId: syncOptions.jobId,
    dbPath: localDbPath,
    alias: syncOptions.jobId,
  };
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

/** Push local SQLite changes via workspace log (Sync V3 — fingerprint Turso CDC removed). */
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

  ensureLocalDbChangeLogReady(localDbPath);
  const linked = buildLinkedSourceForSync(localDbPath, syncOptions);
  const { pushLinkedSourceViaWorkspaceLog } = await import(
    "./syncV3/workspaceLogSync.js"
  );
  return pushLinkedSourceViaWorkspaceLog(linked, credentials, {
    force: syncOptions.force,
    tableNames: syncOptions.tableNames ? [...syncOptions.tableNames] : undefined,
  });
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
  const normalized = path.normalize(localDbPath);
  assertNotReplicaManagedWritablePath(normalized, "openWritableLocalJobDb");
  const db = new Database(normalized);
  db.pragma("journal_mode = WAL");
  db.pragma(`busy_timeout = ${LOCAL_DB_BUSY_TIMEOUT_MS}`);
  return db;
}

/** Install changelog infrastructure + triggers on a linked job DB (idempotent). */
export function ensureLocalDbChangeLogReady(localDbPath: string): void {
  const normalized = path.normalize(localDbPath);
  if (isReplicaManagedDbPathSync(normalized)) {
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
    const syncableTables = filterSyncableTables(listUserTables(localDb));
    const fullyReady =
      changeLogReadyPaths.has(normalized) &&
      isLocalCdcMarkerSet(localDb) &&
      syncableTables.every((tableName) =>
        localInsertTriggerExists(localDb, tableName),
      );
    if (fullyReady) {
      return;
    }

    ensureLocalSyncInfrastructure(localDb);
    for (const tableName of syncableTables) {
      ensureLocalTableSyncTriggers(localDb, tableName);
    }
    markLocalCdcReady(localDb);
    changeLogReadyPaths.add(normalized);
  } finally {
    localDb.close();
  }
}

/** True when the local sqlite file has at least one syncable user table. */
export function localDbHasSyncableUserTables(localDbPath: string): boolean {
  if (!fs.existsSync(localDbPath)) {
    return false;
  }
  const stats = fs.statSync(localDbPath);
  if (stats.size === 0) {
    return false;
  }
  const normalized = path.normalize(localDbPath);
  const openReadonly = isReplicaManagedDbPathSync(normalized);
  const localDb = openReadonly
    ? new Database(normalized, { readonly: true, fileMustExist: true })
    : openWritableLocalJobDb(normalized);
  try {
    return filterSyncableTables(listUserTables(localDb)).length > 0;
  } finally {
    localDb.close();
  }
}

/** Pull remote SQLite changes via workspace log (Sync V3 — fingerprint Turso CDC removed). */
export async function pullTursoToLocalDb(
  localDbPath: string,
  _credentials: TursoCredentials,
  options?: PullSourceSyncOptions,
): Promise<PullResult> {
  const syncOptions = requireLinkedSourceOptions(options);

  fs.mkdirSync(path.dirname(localDbPath), { recursive: true });

  if (options?.onlyIfLocalEmpty && localDbHasSyncableUserTables(localDbPath)) {
    return { status: "skipped", reason: "local_db_has_data" };
  }

  if (options?.skipIfLocalDirty && fs.existsSync(localDbPath)) {
    const stats = fs.statSync(localDbPath);
    if (stats.size > 0) {
      const { isJobDbDirty, loadTursoSyncState } = await import("./tursoSyncState.js");
      if (isJobDbDirty(syncOptions.jobId, localDbPath, loadTursoSyncState())) {
        return { status: "skipped", reason: "local_db_dirty" };
      }
    }
  }

  if (!fs.existsSync(localDbPath)) {
    fs.writeFileSync(localDbPath, "");
  }
  cleanupSqliteSidecars(localDbPath);
  ensureLocalDbChangeLogReady(localDbPath);

  const linked = buildLinkedSourceForSync(localDbPath, syncOptions);
  const { pullLinkedSourceViaWorkspaceLog } = await import(
    "./syncV3/workspaceLogSync.js"
  );
  return pullLinkedSourceViaWorkspaceLog(linked);
}
