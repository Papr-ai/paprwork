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
  countSyncLogSince,
  ensureLocalSyncInfrastructure,
  ensureLocalTableSyncTriggers,
  ensureRemoteSyncInfrastructure,
  ensureRemoteTableSyncTriggers,
  LOG_BATCH_LIMIT,
  maxSyncLogId,
  mirrorSyncLogToRemote,
  pruneSyncLogThrough,
  readRemoteCompactedThroughId,
  readRemoteMaxSyncLogId,
  readRemoteSyncLogSince,
  readSyncLogSince,
  remoteSyncLogExists,
  warnIfLocalSyncLogLarge,
  withRemoteSyncMuted,
  withSyncMuted,
  withSyncMutedAsync,
} from "./tursoSyncLog.js";
import {
  batchInsertLocalTableRows,
  deleteRemoteOrphanRowsByPk,
  REMOTE_READ_CHUNK_ROWS,
} from "./tursoBulkInsert.js";
import { batchUpsertLocalRows } from "./tursoLocalBulkWrite.js";
import {
  applyRemoteSyncLogToLocal,
  localMissingRemoteTables,
  localRemoteSchemaDriftTables,
  prepareRemoteTableForSync,
  pushDeltaToRemote,
  remoteNeedsBootstrap,
  remoteMissingLocalTables,
} from "./tursoDeltaSync.js";
import { ensureRemoteRowSyncColumns } from "./rowSyncColumns.js";
import {
  evaluateBulkPullGate,
  ensureLocalPullSyncInfrastructure,
  findTablesWithFingerprintDrift,
  reconcileDriftedTablesFromRemote,
  reconcileFingerprintDriftAfterDeltaPull,
  repairLocalFromRemoteViaReconcile,
  shouldBlockPullWhileLocalDirty,
  shouldSkipBulkReconcileWhileMerging,
} from "./tursoPullReconcile.js";

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

/**
 * Keep the local PRIMARY KEY when the incoming remote schema has none.
 *
 * A pull rebuilds the local table from the remote definition, which is right
 * for columns and rows but wrong for a constraint the remote has *lost*. Once
 * a remote table is PK-less, every pull strips the local PK too, and the next
 * push copies that back up — the degradation becomes self-sustaining, and no
 * single run looks like the culprit.
 *
 * The visible damage is not a sync error. `INSERT ... ON CONFLICT(id)` needs a
 * PRIMARY KEY or UNIQUE constraint, so a job that upserts fails outright with
 * "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint" —
 * and, until it does, duplicate rows accumulate unchecked.
 *
 * Preferring the local PK is safe in the only direction that matters: adding
 * back a constraint the table was declared with cannot lose data, while
 * dropping one silently admits duplicates. A genuine intentional PK change
 * still goes through planSchemaMigration, which rebuilds explicitly.
 */
function preserveLocalPrimaryKey(
  localDb: Database.Database,
  table: LocalTable,
): LocalTable {
  if (table.columns.some((col) => col.primaryKey)) {
    return table;
  }

  let localColumns: TableColumn[];
  try {
    localColumns = readTableSchema(localDb, table.name);
  } catch {
    return table;
  }

  const localPk = localColumns.filter((col) => col.primaryKey);
  if (localPk.length === 0) {
    return table;
  }

  // Only reinstate a key whose columns all still exist remotely; a PK naming a
  // dropped column would make the rebuilt table unopenable.
  const incoming = new Set(table.columns.map((col) => col.name));
  if (!localPk.every((col) => incoming.has(col.name))) {
    return table;
  }

  const pkNames = new Set(localPk.map((col) => col.name));
  console.warn(
    `[TursoSync] Remote "${table.name}" has no PRIMARY KEY but local declares ` +
      `(${[...pkNames].join(", ")}). Keeping the local key — a PK-less rebuild ` +
      `breaks ON CONFLICT upserts and admits duplicate rows.`,
  );

  return {
    ...table,
    columns: table.columns.map((col) =>
      pkNames.has(col.name) ? { ...col, primaryKey: true } : col,
    ),
    // Drop the remote CREATE TABLE text: it encodes the PK-less shape we are
    // deliberately overriding, and buildCreateTableSql prefers it when present.
    createSql: undefined,
  };
}

export function writeTablesToLocalDb(
  localDb: Database.Database,
  tables: LocalTable[],
): void {
  const writable = tables
    .filter((table) => table.columns.length > 0)
    .map((table) => preserveLocalPrimaryKey(localDb, table));
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

async function pushAllPendingDeltas(
  localDb: Database.Database,
  remote: Client,
  lastPushedLogId: number,
  tableFilter: Set<string> | null,
): Promise<{
  touched: string[];
  lastPushedLogId: number;
  deltaEntries: number;
  remoteLogMaxId: number | undefined;
}> {
  let cursor = lastPushedLogId;
  const touchedSet = new Set<string>();
  let totalEntries = 0;
  let remoteLogMaxId: number | undefined;

  while (true) {
    const batch = readSyncLogSince(localDb, cursor).filter(
      (entry) => !tableFilter || tableFilter.has(entry.tableName),
    );
    if (batch.length === 0) {
      break;
    }

    // Muted: the row writes are ours. The changelog is mirrored explicitly
    // below (one entry per genuine local change) instead of being regenerated
    // by remote CDC, which would duplicate every row we just wrote.
    const batchTouched = await withRemoteSyncMuted(remote, () =>
      pushDeltaToRemote(localDb, remote, batch),
    );
    for (const tableName of batchTouched) {
      touchedSet.add(tableName);
    }
    const batchRemoteMax = await mirrorSyncLogToRemote(remote, batch);
    if (batchRemoteMax !== undefined) {
      remoteLogMaxId = batchRemoteMax;
    }
    cursor = batch[batch.length - 1]!.id;
    totalEntries += batch.length;
    if (batch.length < LOG_BATCH_LIMIT) {
      break;
    }
  }

  return {
    touched: [...touchedSet],
    lastPushedLogId: cursor,
    deltaEntries: totalEntries,
    remoteLogMaxId,
  };
}

async function applyAllRemoteDeltas(
  localDb: Database.Database,
  remote: Client,
  lastPulledLogId: number,
): Promise<{ lastPulledLogId: number; deltaEntries: number }> {
  let cursor = lastPulledLogId;
  let totalEntries = 0;

  while (true) {
    const batch = await readRemoteSyncLogSince(remote, cursor);
    if (batch.length === 0) {
      break;
    }
    await withSyncMutedAsync(localDb, async () => {
      await applyRemoteSyncLogToLocal(localDb, remote, batch);
    });
    cursor = batch[batch.length - 1]!.id;
    totalEntries += batch.length;
    if (batch.length < LOG_BATCH_LIMIT) {
      break;
    }
  }

  return { lastPulledLogId: cursor, deltaEntries: totalEntries };
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
    warnIfLocalSyncLogLarge(localDb, syncOptions.jobId);
    const pendingLogCount = countSyncLogSince(localDb, lastPushedLogId);
    const pendingEntries = readSyncLogSince(localDb, lastPushedLogId).filter(
      (entry) => !tableFilter || tableFilter.has(entry.tableName),
    );
    const missingOnRemote = await remoteMissingLocalTables(remote, tableNames);
    // Bootstrap (full snapshot) only for explicit repair or empty remote — never
    // as a silent heuristic for large oplog backlogs or missing individual tables.
    const bootstrap =
      syncOptions.force === true || (await remoteNeedsBootstrap(remote));

    if (missingOnRemote.length > 0 && !bootstrap) {
      console.warn(
        `[TursoSync] Remote missing ${missingOnRemote.length} local table(s) for ${syncOptions.jobId}: ` +
          `${missingOnRemote.join(", ")} — creating schema + delta/snapshot push`,
      );
    }

    if (bootstrap) {
      // Muted: a full snapshot is OUR write, not a cloud-side user edit. Without
      // the mute every replaced row is re-captured by remote CDC and replayed on
      // the next sync (changelog amplification → oversized batches → failures).
      const syncedRemote = await withRemoteSyncMuted(remote, () =>
        syncTablesToRemote(
          remote,
          tableNames.map((name) => readLocalTable(localDb, name)),
        ),
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
      // Schema migration rebuilds tables server-side (copy rows into a new
      // shape). Muted so the rebuild is not mistaken for user edits.
      await withRemoteSyncMuted(remote, async () => {
        for (const tableName of tablesNeedingSchema) {
          await prepareRemoteTableForSync(remote, localDb, tableName);
        }
      });
    }

    // Safety net: delta path must not touch rows on tables that do not exist remotely yet.
    if (!bootstrap && missingOnRemote.length > 0) {
      await ensureRemoteSyncInfrastructure(remote);
      await withRemoteSyncMuted(remote, async () => {
        for (const tableName of missingOnRemote) {
          await prepareRemoteTableForSync(remote, localDb, tableName);
        }
      });
    }

    if (pendingEntries.length > 0 || pendingLogCount > 0) {
      await ensureRemoteSyncInfrastructure(remote);
      const {
        touched,
        lastPushedLogId: pushedThroughId,
        deltaEntries,
        remoteLogMaxId,
      } = await pushAllPendingDeltas(
        localDb,
        remote,
        lastPushedLogId,
        tableFilter,
      );
      if (deltaEntries === 0) {
        // Filter excluded all pending rows — fall through to snapshot if needed.
      } else {
        pruneSyncLogThrough(localDb, pushedThroughId);
        const remoteVersion = await bumpRemoteSyncVersion(remote);
        if (remoteLogMaxId !== undefined && remoteLogMaxId > 0) {
          await compactRemoteSyncLog(remote, remoteLogMaxId);
        }
        return {
          status: "pushed",
          tables: touched,
          tableFingerprints: currentFingerprints,
          skippedTables: skipped,
          remoteVersion,
          lastPushedLogId: pushedThroughId,
          ...(remoteLogMaxId !== undefined ? { remoteLogMaxId } : {}),
          deltaEntries,
          syncMode: "delta",
        };
      }
    }

    // Changelog empty but fingerprints show local changes (e.g. agent writes
    // before sync triggers were installed). Push all changed tables directly.
    await ensureRemoteSyncInfrastructure(remote);
    const snapshotTables =
      tablesNeedingSchema.length > 0 ? tablesNeedingSchema : changed;
    // Muted for the same reason as bootstrap: this is a platform-owned
    // reconciliation write, not a cloud-side user edit.
    const syncedRemote = await withRemoteSyncMuted(remote, () =>
      syncTablesToRemote(
        remote,
        snapshotTables.map((name) => readLocalTable(localDb, name)),
      ),
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

/** True when the local sqlite file has at least one syncable user table. */
export function localDbHasSyncableUserTables(localDbPath: string): boolean {
  if (!fs.existsSync(localDbPath)) {
    return false;
  }
  const stats = fs.statSync(localDbPath);
  if (stats.size === 0) {
    return false;
  }
  const localDb = openWritableLocalJobDb(localDbPath);
  try {
    return filterSyncableTables(listUserTables(localDb)).length > 0;
  } finally {
    localDb.close();
  }
}

async function performFullTursoPull(
  remote: Client,
  localDbPath: string,
  syncOptions: ReturnType<typeof requireLinkedSourceOptions>,
  options: {
    remoteVersion?: number;
    hasRemoteLog: boolean;
  },
): Promise<PullResult> {
  const hadLocalUserTables = localDbHasSyncableUserTables(localDbPath);
  const localDirty = await isLocalDirtyForPull(localDbPath, syncOptions.jobId);
  if (hadLocalUserTables && localDirty) {
    console.error(
      `[TursoSync] Refused full pull for ${syncOptions.jobId}: local has unpushed changes ` +
        `(push first via Upload now)`,
    );
    return {
      status: "skipped",
      reason: "pull_would_clobber_local",
      remoteVersion: options.remoteVersion,
    };
  }

  const fullPullLogWatermark = options.hasRemoteLog
    ? await readRemoteMaxSyncLogId(remote)
    : undefined;

  const tableNames = filterSyncableTables(await listRemoteUserTables(remote));
  if (tableNames.length === 0) {
    return { status: "skipped", reason: "no_remote_tables", remoteVersion: options.remoteVersion };
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
    return {
      status: "skipped",
      reason: "no_syncable_remote_tables",
      remoteVersion: options.remoteVersion,
    };
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

  const localDb = openWritableLocalJobDb(localDbPath);
  try {
    withSyncMuted(localDb, () => {
      writeTablesToLocalDb(localDb, orderedTables);
    });
    localDb.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    localDb.close();
  }

  return {
    status: "pulled",
    remoteVersion: options.remoteVersion,
    ...(fullPullLogWatermark !== undefined
      ? { lastPulledLogId: fullPullLogWatermark }
      : {}),
    syncMode: "full",
  };
}

async function isLocalDirtyForPull(
  localDbPath: string,
  jobId: string,
): Promise<boolean> {
  if (!fs.existsSync(localDbPath)) {
    return false;
  }
  const stats = fs.statSync(localDbPath);
  if (stats.size === 0) {
    return false;
  }
  const { isJobDbDirty, loadTursoSyncState } = await import("./tursoSyncState.js");
  return isJobDbDirty(jobId, localDbPath, loadTursoSyncState());
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
    const hadLocalUserTables = localDbHasSyncableUserTables(localDbPath);

    // Stale-consumer: compaction deleted oplog entries we never pulled.
    // Reconcile or skip — never bulk-replace local while dirty (see evaluateBulkPullGate).
    let staleConsumer = false;
    if (hasRemoteLog && !syncOptions.force) {
      const compactedThrough = await readRemoteCompactedThroughId(remote);
      staleConsumer = lastPulledLogId < compactedThrough;
    }

    const localDirty = await isLocalDirtyForPull(localDbPath, syncOptions.jobId);
    const mergePull = options?.mergeWhileLocalDirty === true;
    const skipBulkReconcile = shouldSkipBulkReconcileWhileMerging({
      mergeWhileLocalDirty: mergePull,
      localDirty,
    });
    const bulkGate = evaluateBulkPullGate({
      force: syncOptions.force === true,
      hadLocalUserTables,
      localDirty,
      staleConsumer,
    });

    // Stale oplog consumer: reconcile repair instead of silent full DB replace.
    if (staleConsumer && !syncOptions.force && !mergePull) {
      if (bulkGate.action === "skip") {
        console.warn(
          `[TursoSync] Stale oplog consumer for ${syncOptions.jobId} with local unpushed ` +
            `changes — push local first (Upload now) before pulling remote`,
        );
        return {
          status: "skipped",
          reason: bulkGate.reason,
          remoteVersion,
        };
      }

      if (bulkGate.action === "full_pull") {
        return await performFullTursoPull(remote, localDbPath, syncOptions, {
          remoteVersion,
          hasRemoteLog,
        });
      }

      localDb = openWritableLocalJobDb(localDbPath);
      ensureLocalPullSyncInfrastructure(localDb);
      const repair = await repairLocalFromRemoteViaReconcile(localDb, remote, {
        hasRemoteLog,
        lastPulledLogId,
      });
      localDb.pragma("wal_checkpoint(TRUNCATE)");
      if (repair.reconciledTables.length === 0) {
        return {
          status: "skipped",
          reason: "stale_consumer_no_drift",
          remoteVersion,
          ...(repair.lastPulledLogId !== undefined
            ? { lastPulledLogId: repair.lastPulledLogId }
            : {}),
        };
      }
      return {
        status: "pulled",
        remoteVersion,
        syncMode: "reconcile",
        reconciledTables: repair.reconciledTables,
        ...(repair.lastPulledLogId !== undefined
          ? { lastPulledLogId: repair.lastPulledLogId }
          : {}),
      };
    }

    // Block bulk pull while local dirty unless merge pull (delta + LWW).
    if (
      shouldBlockPullWhileLocalDirty({
        force: syncOptions.force,
        hadLocalUserTables,
        localDirty,
        mergeWhileLocalDirty: mergePull,
      })
    ) {
      console.warn(
        `[TursoSync] Blocked pull for ${syncOptions.jobId}: pull_would_clobber_local ` +
          `(local has unpushed changes — push first; pull runs automatically after push)`,
      );
      return {
        status: "skipped",
        reason: "pull_would_clobber_local",
        remoteVersion,
      };
    }

    // Delta pull only when local already has schema. Empty cloud sandboxes
    // must full-pull or they hydrate only tables touched in recent changelog.
    if (
      hasRemoteLog &&
      !syncOptions.force &&
      (!staleConsumer || mergePull) &&
      hadLocalUserTables
    ) {
      localDb = openWritableLocalJobDb(localDbPath);
      ensureLocalPullSyncInfrastructure(localDb);

      let pulledThroughId = lastPulledLogId;
      let deltaEntries = 0;

      const firstBatch = await readRemoteSyncLogSince(remote, lastPulledLogId);
      if (firstBatch.length > 0) {
        const deltaResult = await applyAllRemoteDeltas(
          localDb,
          remote,
          lastPulledLogId,
        );
        pulledThroughId = deltaResult.lastPulledLogId;
        deltaEntries = deltaResult.deltaEntries;
      }

      localDb.pragma("wal_checkpoint(TRUNCATE)");

      const localTableNames = filterSyncableTables(listUserTables(localDb));
      const missingOnLocal = await localMissingRemoteTables(
        remote,
        localTableNames,
      );

      if (missingOnLocal.length > 0 && !skipBulkReconcile) {
        console.warn(
          `[TursoSync] Delta pull incomplete for ${syncOptions.jobId}: ` +
            `local missing ${missingOnLocal.join(", ")} — reconciling missing tables`,
        );
        const reconciledMissing = await reconcileDriftedTablesFromRemote(
          localDb,
          remote,
          missingOnLocal,
        );
        const { reconciledTables: driftReconciled } =
          await reconcileFingerprintDriftAfterDeltaPull(
            localDb,
            remote,
            localTableNames,
          );
        const reconciledTables = [
          ...new Set([...reconciledMissing, ...driftReconciled]),
        ];
        localDb.pragma("wal_checkpoint(TRUNCATE)");
        return {
          status: "pulled",
          remoteVersion,
          lastPulledLogId: pulledThroughId,
          deltaEntries,
          syncMode: deltaEntries > 0 ? "delta" : "reconcile",
          reconciledTables,
        };
      } else if (!skipBulkReconcile) {
        const { reconciledTables } = await reconcileFingerprintDriftAfterDeltaPull(
          localDb,
          remote,
          localTableNames,
        );

        if (deltaEntries > 0 || reconciledTables.length > 0) {
          return {
            status: "pulled",
            remoteVersion,
            lastPulledLogId: pulledThroughId,
            deltaEntries,
            syncMode:
              deltaEntries > 0
                ? "delta"
                : "reconcile",
            ...(reconciledTables.length > 0 ? { reconciledTables } : {}),
          };
        }
      } else if (deltaEntries > 0) {
        const result: PullResult = {
          status: "pulled",
          remoteVersion,
          lastPulledLogId: pulledThroughId,
          deltaEntries,
          syncMode: "delta",
        };
        localDb.close();
        localDb = null;
        return result;
      }

      localDb.close();
      localDb = null;
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
      const probeDb = openWritableLocalJobDb(localDbPath);
      try {
        const localTableNames = filterSyncableTables(listUserTables(probeDb));
        const missingOnLocal = await localMissingRemoteTables(
          remote,
          localTableNames,
        );
        if (missingOnLocal.length === 0) {
          const drifted = await findTablesWithFingerprintDrift(
            probeDb,
            remote,
            localTableNames,
          );
          if (drifted.length === 0) {
            return {
              status: "skipped",
              reason: "remote_unchanged",
              remoteVersion,
            };
          }

          if (skipBulkReconcile) {
            return {
              status: "skipped",
              reason: "merge_pull_skipped_bulk_reconcile",
              remoteVersion,
            };
          }

          console.warn(
            `[TursoSync] Remote version unchanged but fingerprint drift on ` +
              `${drifted.join(", ")} for ${syncOptions.jobId} — reconciling`,
          );
          const reconciledTables = await reconcileDriftedTablesFromRemote(
            probeDb,
            remote,
            drifted,
          );
          probeDb.pragma("wal_checkpoint(TRUNCATE)");
          return {
            status: "pulled",
            remoteVersion,
            lastPulledLogId,
            syncMode: "reconcile",
            reconciledTables,
          };
        }
        if (skipBulkReconcile) {
          return {
            status: "skipped",
            reason: "merge_pull_skipped_bulk_reconcile",
            remoteVersion,
          };
        }
        console.warn(
          `[TursoSync] Remote unchanged but local missing ${missingOnLocal.join(", ")} ` +
            `for ${syncOptions.jobId} — reconciling missing tables`,
        );
        ensureLocalPullSyncInfrastructure(probeDb);
        const reconciledTables = await reconcileDriftedTablesFromRemote(
          probeDb,
          remote,
          missingOnLocal,
        );
        probeDb.pragma("wal_checkpoint(TRUNCATE)");
        return {
          status: "pulled",
          remoteVersion,
          lastPulledLogId,
          syncMode: "reconcile",
          reconciledTables,
        };
      } finally {
        probeDb.close();
      }
    }

    if (bulkGate.action === "skip") {
      if (mergePull && localDirty) {
        return {
          status: "skipped",
          reason: "merge_pull_no_remote_delta",
          remoteVersion,
        };
      }
      console.warn(
        `[TursoSync] Blocked bulk pull for ${syncOptions.jobId}: ${bulkGate.reason} ` +
          `(push local first via Upload now, or repair when local is clean)`,
      );
      return {
        status: "skipped",
        reason: bulkGate.reason,
        remoteVersion,
      };
    }

    if (bulkGate.action === "full_pull") {
      return await performFullTursoPull(remote, localDbPath, syncOptions, {
        remoteVersion,
        hasRemoteLog,
      });
    }

    localDb = openWritableLocalJobDb(localDbPath);
    try {
      ensureLocalPullSyncInfrastructure(localDb);
      const repair = await repairLocalFromRemoteViaReconcile(localDb, remote, {
        hasRemoteLog,
        lastPulledLogId,
      });
      localDb.pragma("wal_checkpoint(TRUNCATE)");
      if (repair.reconciledTables.length === 0) {
        return {
          status: "skipped",
          reason: "no_remote_drift",
          remoteVersion,
        };
      }
      return {
        status: "pulled",
        remoteVersion,
        syncMode: "reconcile",
        reconciledTables: repair.reconciledTables,
        ...(repair.lastPulledLogId !== undefined
          ? { lastPulledLogId: repair.lastPulledLogId }
          : {}),
      };
    } finally {
      localDb.close();
      localDb = null;
    }
  } finally {
    localDb?.close();
    remote.close();
  }
}
