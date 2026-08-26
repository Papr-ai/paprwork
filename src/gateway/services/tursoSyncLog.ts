/**
 * Row-level CDC changelog for Turso boundary sync.
 * SQLite triggers on user tables append to _papr_sync_log for any writer
 * (Python job, Node, bash, mini-app /api/db/* on desktop).
 */

import type { Client } from "@libsql/client";
import type Database from "better-sqlite3";
import { PAPR_ROW_SYNC_COLUMNS } from "../../core/types/jobMigrations.js";
import {
  quoteIdent,
  readRemoteTableSchema,
  readTableSchema,
  type TableColumn,
} from "./tursoSyncBridgeCore.js";
import {
  dropLocalRowSyncTriggers,
  dropRemoteRowSyncTriggers,
  ensureLocalRowSyncColumns,
  ensureRemoteRowSyncColumns,
} from "./rowSyncColumns.js";

export const SYNC_LOG_TABLE = "_papr_sync_log";
export const SYNC_MUTE_TABLE = "_papr_sync_mute";

/** Local/remote infra — never user sync tables; exclude from drift + row ship. */
export const SYNC_INFRA_TABLES = new Set([
  SYNC_LOG_TABLE,
  SYNC_MUTE_TABLE,
  "_papr_materialized",
  "_papr_sync_infra",
  "_papr_oplog",
]);

export type SyncLogOp = "insert" | "update" | "delete";

export interface SyncLogEntry {
  id: number;
  tableName: string;
  op: SyncLogOp;
  rowPk: unknown[];
}

/** Collapse oplog to last op per (table, primary key) — reduces redundant push work. */
export function compactSyncLogEntries(
  entries: readonly SyncLogEntry[],
): SyncLogEntry[] {
  const byKey = new Map<string, SyncLogEntry>();
  for (const entry of entries) {
    byKey.set(`${entry.tableName}\0${JSON.stringify(entry.rowPk)}`, entry);
  }
  return [...byKey.values()].sort((left, right) => left.id - right.id);
}

const MUTE_ROW_ID = 1;
/** Max changelog rows read/applied per batch (loop until exhausted). */
export const LOG_BATCH_LIMIT = 10_000;

/** @deprecated No longer triggers bootstrap — kept for log compatibility only. */
export const LOCAL_LOG_BOOTSTRAP_THRESHOLD = 25_000;

/** Log a warning when the local changelog exceeds this size. */
export const LOCAL_LOG_WARN_THRESHOLD = 10_000;

function triggerSuffix(tableName: string): string {
  return tableName.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 48);
}

function pkJsonExpr(columns: TableColumn[], rowPrefix: "NEW" | "OLD"): string | null {
  const pkCols = columns.filter((col) => col.primaryKey);
  if (pkCols.length === 0) {
    return null;
  }
  const parts = pkCols.map((col) => `${rowPrefix}.${quoteIdent(col.name)}`);
  return `json_array(${parts.join(", ")})`;
}

function muteWhenClause(): string {
  return (
    `(SELECT COALESCE((SELECT depth FROM ${quoteIdent(SYNC_MUTE_TABLE)} ` +
    `WHERE id = ${MUTE_ROW_ID}), 0)) = 0`
  );
}

/** Skip CDC when only platform row-metadata columns changed (version bump trigger). */
function cdcUpdateWhenClause(columns: TableColumn[]): string {
  const mute = muteWhenClause();
  const hasRowVersion = columns.some(
    (col) => col.name === PAPR_ROW_SYNC_COLUMNS.rowVersion,
  );
  if (!hasRowVersion) {
    return mute;
  }
  const versionCol = quoteIdent(PAPR_ROW_SYNC_COLUMNS.rowVersion);
  // IS, not =: `NULL = NULL` is NULL (falsy) in SQLite, so user edits to any
  // row with an uninitialised version were never written to the change log —
  // the edit stayed local forever with nothing reported as failed.
  return `${mute} AND OLD.${versionCol} IS NEW.${versionCol}`;
}

/**
 * Tables that cannot carry change capture, so the warning is logged once each
 * rather than on every sync pass.
 */
const cdcDisabledWarned = new Set<string>();

function warnCdcDisabledOnce(tableName: string): void {
  if (cdcDisabledWarned.has(tableName)) {
    return;
  }
  cdcDisabledWarned.add(tableName);
  console.warn(
    `[TursoSyncLog] "${tableName}" has no PRIMARY KEY — change capture is disabled ` +
      `for it, so local inserts and deletes will never reach Turso. ` +
      `Add a PRIMARY KEY (or let schema drift heal restore it) to re-enable sync.`,
  );
}

export function parseRowPkJson(raw: unknown): unknown[] {
  if (typeof raw !== "string") {
    throw new Error("sync log row_pk must be a JSON string");
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("sync log row_pk must be a JSON array");
  }
  return parsed;
}

export function tableHasPrimaryKey(db: Database.Database, tableName: string): boolean {
  return readTableSchema(db, tableName).some((col) => col.primaryKey);
}

function createSyncLogTableSql(): string {
  return (
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(SYNC_LOG_TABLE)} (` +
    `id INTEGER PRIMARY KEY AUTOINCREMENT, ` +
    `table_name TEXT NOT NULL, ` +
    `op TEXT NOT NULL CHECK (op IN ('insert', 'update', 'delete')), ` +
    `row_pk TEXT NOT NULL, ` +
    `changed_at TEXT NOT NULL DEFAULT (datetime('now'))` +
    `)`
  );
}

function createSyncInfraMarkerTableSql(): string {
  return (
    `CREATE TABLE IF NOT EXISTS ${quoteIdent("_papr_sync_infra")} (` +
    `key TEXT PRIMARY KEY, value TEXT NOT NULL` +
    `)`
  );
}

const CDC_MARKER_KEY = "cdc_triggers_v1";

export function isLocalCdcMarkerSet(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT value FROM ${quoteIdent("_papr_sync_infra")} WHERE key = ? LIMIT 1`,
    )
    .get(CDC_MARKER_KEY) as { value: string } | undefined;
  return row?.value === "1";
}

export function markLocalCdcReady(db: Database.Database): void {
  db.prepare(
    `INSERT OR REPLACE INTO ${quoteIdent("_papr_sync_infra")} (key, value) VALUES (?, '1')`,
  ).run(CDC_MARKER_KEY);
}

export function localInsertTriggerExists(
  db: Database.Database,
  tableName: string,
): boolean {
  const suffix = triggerSuffix(tableName);
  return triggerExists(db, `_papr_tr_${suffix}_ai`);
}

function createSyncMuteTableSql(): string {
  return (
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(SYNC_MUTE_TABLE)} (` +
    `id INTEGER PRIMARY KEY CHECK (id = ${MUTE_ROW_ID}), ` +
    `depth INTEGER NOT NULL DEFAULT 0` +
    `)`
  );
}

/**
 * Clear a leaked sync-mute depth left behind by a previous process.
 *
 * `depth` is a re-entrancy counter stored IN the database, but it only ever
 * describes work happening inside a live process. withSyncMuted() decrements
 * it in a finally block — which never runs if the process is killed, crashes,
 * or the DB write fails mid-scope. The non-zero value then survives on disk
 * forever.
 *
 * Every CDC trigger is guarded by `depth = 0`, so a leaked depth silently
 * disables change capture for the whole database: local writes still succeed,
 * but nothing is queued for Turso, and the next cloud pull overwrites the row
 * with the stale remote value. To the user, edits "don't save" — they persist
 * locally, then get reverted by sync.
 *
 * Nothing legitimately holds a mute across process boundaries, so any depth
 * observed at startup is by definition stale. Reset it once, when the
 * infrastructure is first ensured for this connection.
 */
function resetLeakedSyncMuteDepth(db: Database.Database): void {
  const row = db
    .prepare(
      `SELECT depth FROM ${quoteIdent(SYNC_MUTE_TABLE)} WHERE id = ${MUTE_ROW_ID}`,
    )
    .get() as { depth?: number } | undefined;
  const depth = Number(row?.depth ?? 0);
  if (!Number.isFinite(depth) || depth === 0) {
    return;
  }
  db.exec(
    `UPDATE ${quoteIdent(SYNC_MUTE_TABLE)} SET depth = 0 WHERE id = ${MUTE_ROW_ID}`,
  );
  console.warn(
    `[tursoSyncLog] cleared leaked sync mute depth (${depth}) — CDC was disabled, ` +
      `local edits would not have synced. Likely a process exit inside withSyncMuted().`,
  );
}

/** Connections that already had their leaked mute depth cleared. */
const muteDepthCheckedDbs = new WeakSet<Database.Database>();

export function ensureLocalSyncInfrastructure(db: Database.Database): void {
  db.exec(createSyncLogTableSql());
  db.exec(createSyncMuteTableSql());
  db.exec(createSyncInfraMarkerTableSql());
  db.exec(
    `INSERT OR IGNORE INTO ${quoteIdent(SYNC_MUTE_TABLE)} (id, depth) VALUES (${MUTE_ROW_ID}, 0)`,
  );
  // Once per connection: a mute can never legitimately outlive a process.
  if (!muteDepthCheckedDbs.has(db)) {
    muteDepthCheckedDbs.add(db);
    resetLeakedSyncMuteDepth(db);
  }
}

export async function ensureRemoteSyncInfrastructure(remote: Client): Promise<void> {
  const { ensureRemotePlatformTursoSchema } = await import("./tursoPlatformSchema.js");
  await ensureRemotePlatformTursoSchema(remote);
}

/**
 * Never let the counter go negative — a stuck-negative depth also breaks CDC.
 *
 * Built lazily: this module and tursoSyncBridgeCore import each other, so at
 * module-evaluation time `quoteIdent` may not be initialised yet. A top-level
 * template literal here throws "quoteIdent is not a function" and takes the
 * whole import graph down.
 */
function muteReleaseSql(): string {
  return (
    `UPDATE ${quoteIdent(SYNC_MUTE_TABLE)} SET depth = MAX(depth - 1, 0) ` +
    `WHERE id = ${MUTE_ROW_ID}`
  );
}

const REMOTE_MUTE_RELEASE_ATTEMPTS = 3;

/**
 * Suppress Turso CDC while Paprwork applies its own snapshot/delta/schema writes.
 * Genuine local changes are mirrored explicitly after the muted write. Without
 * this guard, every platform upsert is captured as a new cloud-side change and
 * the next sync replays it again, creating an unbounded feedback loop.
 */
export async function withRemoteSyncMuted<T>(
  remote: Client,
  fn: () => Promise<T>,
): Promise<T> {
  await ensureRemoteSyncInfrastructure(remote);
  await remote.execute(
    `UPDATE ${quoteIdent(SYNC_MUTE_TABLE)} SET depth = depth + 1 WHERE id = ${MUTE_ROW_ID}`,
  );
  try {
    return await fn();
  } finally {
    let released = false;
    for (let attempt = 1; attempt <= REMOTE_MUTE_RELEASE_ATTEMPTS; attempt += 1) {
      try {
        await remote.execute(muteReleaseSql());
        released = true;
        break;
      } catch (error) {
        if (attempt === REMOTE_MUTE_RELEASE_ATTEMPTS) {
          console.error("[tursoSyncLog] failed to release remote sync mute", error);
        } else {
          await new Promise((resolve) => setTimeout(resolve, attempt * 100));
        }
      }
    }
    if (!released) {
      console.error(
        "[tursoSyncLog] remote CDC may remain muted; next sync must repair the mute depth",
      );
    }
  }
}

function triggerExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ? LIMIT 1`,
    )
    .get(name) as { 1: number } | undefined;
  return row !== undefined;
}

async function remoteTriggerExists(remote: Client, name: string): Promise<boolean> {
  const result = await remote.execute({
    sql: `SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ? LIMIT 1`,
    args: [name],
  });
  return result.rows.length > 0;
}

/** Serialize remote _au trigger refresh per table (debounced cloud pushes can overlap). */
const remoteAuTriggerRefreshLocks = new Map<string, Promise<void>>();

export function isSqliteTriggerAlreadyExistsError(message: string): boolean {
  return /trigger .+ already exists/i.test(message);
}

async function refreshRemoteCdcUpdateTrigger(
  remote: Client,
  tableName: string,
  suffix: string,
  columns: TableColumn[],
): Promise<void> {
  const updateSql = buildCdcUpdateTriggerSql(tableName, suffix, columns);
  if (!updateSql) {
    return;
  }

  const lockKey = tableName;
  const prior = remoteAuTriggerRefreshLocks.get(lockKey);
  const refreshPromise = (async () => {
    if (prior) {
      await prior.catch(() => undefined);
    }

    const triggerName = `_papr_tr_${suffix}_au`;
    await remote.execute({
      sql: `DROP TRIGGER IF EXISTS ${quoteIdent(triggerName)}`,
      args: [],
    });

    if (await remoteTriggerExists(remote, triggerName)) {
      return;
    }

    try {
      await remote.execute({ sql: updateSql, args: [] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isSqliteTriggerAlreadyExistsError(message)) {
        return;
      }
      throw error;
    }
  })();

  remoteAuTriggerRefreshLocks.set(lockKey, refreshPromise);
  try {
    await refreshPromise;
  } finally {
    if (remoteAuTriggerRefreshLocks.get(lockKey) === refreshPromise) {
      remoteAuTriggerRefreshLocks.delete(lockKey);
    }
  }
}

function buildTriggerSql(
  tableName: string,
  suffix: string,
  columns: TableColumn[],
): string[] {
  const pkExprInsert = pkJsonExpr(columns, "NEW");
  const pkExprDelete = pkJsonExpr(columns, "OLD");
  if (!pkExprInsert || !pkExprDelete) {
    return [];
  }
  const quotedTable = quoteIdent(tableName);
  const quotedLog = quoteIdent(SYNC_LOG_TABLE);
  const when = muteWhenClause();
  const statements: string[] = [];

  statements.push(
    `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(`_papr_tr_${suffix}_ai`)} ` +
      `AFTER INSERT ON ${quotedTable} ` +
      `WHEN ${when} ` +
      `BEGIN ` +
      `INSERT INTO ${quotedLog} (table_name, op, row_pk) ` +
      `VALUES ('${tableName.replace(/'/g, "''")}', 'insert', ${pkExprInsert}); ` +
      `END`,
  );
  statements.push(
    `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(`_papr_tr_${suffix}_au`)} ` +
      `AFTER UPDATE ON ${quotedTable} ` +
      `WHEN ${cdcUpdateWhenClause(columns)} ` +
      `BEGIN ` +
      `INSERT INTO ${quotedLog} (table_name, op, row_pk) ` +
      `VALUES ('${tableName.replace(/'/g, "''")}', 'update', ${pkExprInsert}); ` +
      `END`,
  );
  statements.push(
    `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(`_papr_tr_${suffix}_ad`)} ` +
      `AFTER DELETE ON ${quotedTable} ` +
      `WHEN ${when} ` +
      `BEGIN ` +
      `INSERT INTO ${quotedLog} (table_name, op, row_pk) ` +
      `VALUES ('${tableName.replace(/'/g, "''")}', 'delete', ${pkExprDelete}); ` +
      `END`,
  );
  return statements;
}

function buildCdcUpdateTriggerSql(
  tableName: string,
  suffix: string,
  columns: TableColumn[],
): string | null {
  const pkExprInsert = pkJsonExpr(columns, "NEW");
  if (!pkExprInsert) {
    return null;
  }
  const quotedTable = quoteIdent(tableName);
  const quotedLog = quoteIdent(SYNC_LOG_TABLE);
  return (
    `CREATE TRIGGER ${quoteIdent(`_papr_tr_${suffix}_au`)} ` +
    `AFTER UPDATE ON ${quotedTable} ` +
    `WHEN ${cdcUpdateWhenClause(columns)} ` +
    `BEGIN ` +
    `INSERT INTO ${quotedLog} (table_name, op, row_pk) ` +
    `VALUES ('${tableName.replace(/'/g, "''")}', 'update', ${pkExprInsert}); ` +
    `END`
  );
}

/**
 * Recreate the CDC update trigger atomically.
 *
 * The DROP and CREATE used to be two separate db.exec() calls. Because the
 * update trigger is created WITHOUT `IF NOT EXISTS` (its body depends on the
 * current column set, so it must be replaced rather than skipped), an
 * interruption or a concurrent sync between the two statements could leave a
 * SECOND `_papr_tr_<suffix>_au` row in sqlite_master. SQLite then refuses to
 * parse the schema at all:
 *
 *   malformed database schema (_papr_tr_investors_au)
 *     - trigger "_papr_tr_investors_au" already exists
 *
 * Every query against that database fails, and mini-apps render an empty list —
 * indistinguishable from data loss.
 *
 * Wrapping both statements in a single transaction makes the swap atomic: it
 * either fully applies or fully rolls back, so a duplicate can never be
 * committed. This mirrors the guards the remote path already has
 * (see refreshRemoteCdcUpdateTrigger).
 */
function refreshLocalCdcUpdateTrigger(
  db: Database.Database,
  tableName: string,
  suffix: string,
  columns: TableColumn[],
): void {
  const updateSql = buildCdcUpdateTriggerSql(tableName, suffix, columns);
  if (!updateSql) {
    return;
  }
  const triggerName = `_papr_tr_${suffix}_au`;
  const swap = db.transaction(() => {
    db.exec(`DROP TRIGGER IF EXISTS ${quoteIdent(triggerName)}`);
    db.exec(updateSql);
  });
  try {
    swap();
  } catch (error) {
    // Another writer won the race and already recreated an equivalent trigger.
    // The transaction rolled back, so the schema is still valid — leave it be.
    const message = error instanceof Error ? error.message : String(error);
    if (isSqliteTriggerAlreadyExistsError(message)) {
      return;
    }
    throw error;
  }
}

export function dropLocalTableSyncTriggers(
  db: Database.Database,
  tableName: string,
): void {
  const suffix = triggerSuffix(tableName);
  for (const part of ["ai", "au", "ad"] as const) {
    db.exec(`DROP TRIGGER IF EXISTS ${quoteIdent(`_papr_tr_${suffix}_${part}`)}`);
  }
  dropLocalRowSyncTriggers(db, tableName);
}

export async function dropRemoteTableSyncTriggers(
  remote: Client,
  tableName: string,
): Promise<void> {
  const suffix = triggerSuffix(tableName);
  for (const part of ["ai", "au", "ad"] as const) {
    await remote.execute({
      sql: `DROP TRIGGER IF EXISTS ${quoteIdent(`_papr_tr_${suffix}_${part}`)}`,
      args: [],
    });
  }
  await dropRemoteRowSyncTriggers(remote, tableName);
}

export function ensureLocalTableSyncTriggers(
  db: Database.Database,
  tableName: string,
): boolean {
  ensureLocalSyncInfrastructure(db);
  const columns = readTableSchema(db, tableName);
  if (!pkJsonExpr(columns, "NEW")) {
    // No PRIMARY KEY means row_pk cannot be expressed, so this table gets no
    // insert/delete change capture at all. Callers ignore this boolean, so
    // without a warning the table just stops syncing: rows accumulate locally
    // and the replica stays empty with every push still reporting success.
    warnCdcDisabledOnce(tableName);
    return false;
  }
  ensureLocalRowSyncColumns(db, tableName);
  const syncColumns = readTableSchema(db, tableName);
  const suffix = triggerSuffix(tableName);
  const insertName = `_papr_tr_${suffix}_ai`;
  if (!triggerExists(db, insertName)) {
    for (const sql of buildTriggerSql(tableName, suffix, syncColumns)) {
      if (!sql.includes("_au")) {
        db.exec(sql);
      }
    }
  }
  refreshLocalCdcUpdateTrigger(db, tableName, suffix, syncColumns);
  return true;
}

export async function ensureRemoteTableSyncTriggers(
  remote: Client,
  columns: TableColumn[],
  tableName: string,
): Promise<boolean> {
  await ensureRemoteSyncInfrastructure(remote);
  await ensureRemoteRowSyncColumns(remote, tableName);
  if (!pkJsonExpr(columns, "NEW")) {
    return false;
  }
  const syncColumns = await readRemoteTableSchema(remote, tableName);
  const triggerColumns = syncColumns.length > 0 ? syncColumns : columns;
  const suffix = triggerSuffix(tableName);
  const insertName = `_papr_tr_${suffix}_ai`;
  if (!(await remoteTriggerExists(remote, insertName))) {
    for (const sql of buildTriggerSql(tableName, suffix, triggerColumns)) {
      if (!sql.includes("_au")) {
        await remote.execute({ sql, args: [] });
      }
    }
  }
  await refreshRemoteCdcUpdateTrigger(remote, tableName, suffix, triggerColumns);
  return true;
}

export function withSyncMuted<T>(db: Database.Database, fn: () => T): T {
  ensureLocalSyncInfrastructure(db);
  db.exec(
    `UPDATE ${quoteIdent(SYNC_MUTE_TABLE)} SET depth = depth + 1 WHERE id = ${MUTE_ROW_ID}`,
  );
  try {
    return fn();
  } finally {
    // Must not throw: an error here would leak the mute and silently disable CDC.
    try {
      db.exec(muteReleaseSql());
    } catch (error) {
      console.error("[tursoSyncLog] failed to release sync mute", error);
    }
  }
}

export async function withSyncMutedAsync<T>(
  db: Database.Database,
  fn: () => Promise<T>,
): Promise<T> {
  ensureLocalSyncInfrastructure(db);
  db.exec(
    `UPDATE ${quoteIdent(SYNC_MUTE_TABLE)} SET depth = depth + 1 WHERE id = ${MUTE_ROW_ID}`,
  );
  try {
    return await fn();
  } finally {
    // Must not throw: an error here would leak the mute and silently disable CDC.
    try {
      db.exec(muteReleaseSql());
    } catch (error) {
      console.error("[tursoSyncLog] failed to release sync mute", error);
    }
  }
}

function localSyncInfrastructureReady(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
    )
    .get(SYNC_LOG_TABLE) as { 1: number } | undefined;
  return row !== undefined;
}

export function readSyncLogSince(
  db: Database.Database,
  afterId: number,
  limit: number = LOG_BATCH_LIMIT,
): SyncLogEntry[] {
  if (db.readonly) {
    if (!localSyncInfrastructureReady(db)) {
      throw new Error(
        `[TursoSyncLog] Sync log not ready on readonly DB — call ensureLocalDbChangeLogReady first`,
      );
    }
  } else {
    ensureLocalSyncInfrastructure(db);
  }
  const rows = db
    .prepare(
      `SELECT id, table_name, op, row_pk FROM ${quoteIdent(SYNC_LOG_TABLE)} ` +
        `WHERE id > ? ORDER BY id ASC LIMIT ?`,
    )
    .all(afterId, limit) as Array<{
    id: number;
    table_name: string;
    op: string;
    row_pk: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    tableName: row.table_name,
    op: row.op as SyncLogOp,
    rowPk: parseRowPkJson(row.row_pk),
  }));
}

export async function readRemoteSyncLogSince(
  remote: Client,
  afterId: number,
  limit: number = LOG_BATCH_LIMIT,
): Promise<SyncLogEntry[]> {
  try {
    const result = await remote.execute({
      sql:
        `SELECT id, table_name, op, row_pk FROM ${quoteIdent(SYNC_LOG_TABLE)} ` +
        `WHERE id > ? ORDER BY id ASC LIMIT ?`,
      args: [afterId, limit],
    });
    return result.rows.map((row) => ({
      id: Number(row.id),
      tableName: String(row.table_name ?? ""),
      op: String(row.op ?? "") as SyncLogOp,
      rowPk: parseRowPkJson(String(row.row_pk ?? "[]")),
    }));
  } catch {
    return [];
  }
}

export async function remoteSyncLogExists(remote: Client): Promise<boolean> {
  try {
    const result = await remote.execute({
      sql: `SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`,
      args: [SYNC_LOG_TABLE],
    });
    return result.rows.length > 0;
  } catch {
    return false;
  }
}

export function maxSyncLogId(db: Database.Database): number {
  ensureLocalSyncInfrastructure(db);
  const row = db
    .prepare(`SELECT COALESCE(MAX(id), 0) AS max_id FROM ${quoteIdent(SYNC_LOG_TABLE)}`)
    .get() as { max_id: number };
  return row.max_id ?? 0;
}

export function countSyncLogSince(db: Database.Database, afterId: number): number {
  ensureLocalSyncInfrastructure(db);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM ${quoteIdent(SYNC_LOG_TABLE)} WHERE id > ?`,
    )
    .get(afterId) as { count: number };
  return row.count ?? 0;
}

export function warnIfLocalSyncLogLarge(
  db: Database.Database,
  syncKey: string,
): void {
  const total = countSyncLogSince(db, 0);
  if (total >= LOCAL_LOG_WARN_THRESHOLD) {
    console.warn(
      `[TursoSync] Local changelog for ${syncKey} has ${total} entries ` +
        `(warn ≥${LOCAL_LOG_WARN_THRESHOLD}). Bulk reseeds inflate this table; ` +
        `push replays oplog in ${LOG_BATCH_LIMIT}-row batches (no silent bootstrap).`,
    );
  }
}

export function pruneSyncLogThrough(db: Database.Database, throughId: number): void {
  if (throughId <= 0) {
    return;
  }
  db.prepare(`DELETE FROM ${quoteIdent(SYNC_LOG_TABLE)} WHERE id <= ?`).run(throughId);
}

/** Mirrors local changelog entries into the remote log. Returns the remote
 * log MAX(id) after the insert (read in the same transaction) so callers can
 * record it as lastPulledLogId — preventing our own mirrored entries from
 * being detected as "remote ahead" on the next push (self-echo). */
export async function mirrorSyncLogToRemote(
  remote: Client,
  entries: readonly SyncLogEntry[],
): Promise<number | undefined> {
  if (entries.length === 0) {
    return undefined;
  }
  await ensureRemoteSyncInfrastructure(remote);
  const sql =
    `INSERT INTO ${quoteIdent(SYNC_LOG_TABLE)} (table_name, op, row_pk, changed_at) ` +
    `VALUES (?, ?, ?, datetime('now'))`;
  const statements = entries.map((entry) => ({
    sql,
    args: [entry.tableName, entry.op, JSON.stringify(entry.rowPk)] as (
      | string
      | number
      | bigint
      | null
      | Uint8Array
    )[],
  }));
  const results = await remote.batch(
    [
      ...statements,
      {
        sql: `SELECT COALESCE(MAX(id), 0) AS max_id FROM ${quoteIdent(SYNC_LOG_TABLE)}`,
        args: [],
      },
    ],
    "write",
  );
  const last = results[results.length - 1];
  const maxId = Number(last?.rows?.[0]?.max_id);
  return Number.isFinite(maxId) ? maxId : undefined;
}

/** Highest id in the remote _papr_sync_log (0 when empty, undefined on error/missing). */
export async function readRemoteMaxSyncLogId(remote: Client): Promise<number | undefined> {
  try {
    const result = await remote.execute(
      `SELECT COALESCE(MAX(id), 0) AS max_id FROM ${quoteIdent(SYNC_LOG_TABLE)}`,
    );
    const maxId = Number(result.rows[0]?.max_id);
    return Number.isFinite(maxId) ? maxId : undefined;
  } catch {
    return undefined;
  }
}

export function buildPkWhereClause(columns: TableColumn[]): {
  sql: string;
  usePk: boolean;
} {
  const pkCols = columns.filter((col) => col.primaryKey);
  if (pkCols.length === 0) {
    return { sql: "", usePk: false };
  }
  const clauses = pkCols.map((col) => `${quoteIdent(col.name)} = ?`);
  return { sql: clauses.join(" AND "), usePk: true };
}

/* ── Remote changelog compaction ─────────────────────────────────────────── */

/** Remote _papr_sync_meta table name (mirrors SYNC_META_TABLE in tursoSyncBridgeCore). */
const SYNC_META_TABLE_NAME = "_papr_sync_meta";

/** Compact only when at least this many un-compacted entries have accumulated. */
export const REMOTE_LOG_COMPACT_MIN_ENTRIES = 1_000;
/** Keep entries newer than this many days regardless of watermarks —
 * insurance for consumers not yet tracked in sync state (e.g. a second device). */
export const REMOTE_LOG_RETENTION_DAYS = 7;

/**
 * Hard ceiling on remote changelog size. Above this the retention floor is
 * waived for entries at or below the watermark.
 *
 * The 7-day floor assumes the log only grows from real user edits. Amplified
 * churn (schema reconcile + snapshot replays) can add tens of thousands of
 * same-day entries, which the floor refuses to touch — so the log grows without
 * bound, every pull drags the whole backlog, and pushes fail on oversized
 * requests. Entries below the watermark are already pushed AND pulled, so
 * dropping them loses nothing; stale consumers still detect the gap through
 * compacted_through_id and full-resync.
 */
export const REMOTE_LOG_HARD_CEILING = 25_000;

export interface RemoteLogCompactionResult {
  compacted: boolean;
  throughId?: number;
  reason?: string;
  /** True when the retention floor was waived because of the hard ceiling. */
  ceilingOverride?: boolean;
}

/** Total rows in the remote changelog (undefined when unreadable). */
export async function readRemoteSyncLogCount(
  remote: Client,
): Promise<number | undefined> {
  try {
    const result = await remote.execute(
      `SELECT COUNT(*) AS count FROM ${quoteIdent(SYNC_LOG_TABLE)}`,
    );
    const count = Number(result.rows[0]?.count);
    return Number.isFinite(count) ? count : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Highest compacted remote log id. Consumers whose lastPulledLogId is BELOW
 * this value have missed entries that no longer exist and MUST full-resync
 * instead of delta-pulling (anti-divergence escape hatch).
 */
export async function readRemoteCompactedThroughId(remote: Client): Promise<number> {
  try {
    const result = await remote.execute(
      `SELECT compacted_through_id FROM ${quoteIdent(SYNC_META_TABLE_NAME)} WHERE id = 1`,
    );
    const value = Number(result.rows[0]?.compacted_through_id);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0; // table/column absent — nothing compacted yet
  }
}

async function ensureRemoteCompactionMeta(remote: Client): Promise<void> {
  const { ensureRemotePlatformTursoSchema } = await import("./tursoPlatformSchema.js");
  await ensureRemotePlatformTursoSchema(remote);
}

/**
 * Watermark-based remote changelog compaction. Deletes entries every known
 * consumer has already pulled (id <= watermark), subject to a retention floor,
 * and records compacted_through_id so stale consumers detect the gap and
 * full-resync. Best-effort: never throws.
 */
export async function compactRemoteSyncLog(
  remote: Client,
  watermarkId: number,
  options?: { minEntries?: number; retentionDays?: number },
): Promise<RemoteLogCompactionResult> {
  const minEntries = options?.minEntries ?? REMOTE_LOG_COMPACT_MIN_ENTRIES;
  const retentionDays = options?.retentionDays ?? REMOTE_LOG_RETENTION_DAYS;
  if (watermarkId <= 0) {
    return { compacted: false, reason: "no_watermark" };
  }
  try {
    const compactedThrough = await readRemoteCompactedThroughId(remote);
    if (watermarkId - compactedThrough < minEntries) {
      return { compacted: false, reason: "below_threshold" };
    }
    // Retention floor: only entries older than retentionDays are eligible.
    const boundaryResult = await remote.execute({
      sql:
        `SELECT COALESCE(MAX(id), 0) AS boundary FROM ${quoteIdent(SYNC_LOG_TABLE)} ` +
        `WHERE id <= ? AND changed_at <= datetime('now', ?)`,
      args: [watermarkId, `-${retentionDays} days`],
    });
    let boundary = Number(boundaryResult.rows[0]?.boundary ?? 0);
    let ceilingOverride = false;

    if (!Number.isFinite(boundary) || boundary <= compactedThrough) {
      // Nothing is old enough to retire. Normally correct — but a log that has
      // blown past the hard ceiling is pathological (amplified churn, not user
      // edits) and will keep degrading every sync. Everything at or below the
      // watermark has already been pushed and pulled, so retire it anyway.
      const logCount = await readRemoteSyncLogCount(remote);
      if (logCount === undefined || logCount < REMOTE_LOG_HARD_CEILING) {
        return { compacted: false, reason: "retention_floor" };
      }
      boundary = watermarkId;
      ceilingOverride = true;
      console.warn(
        `[tursoSyncLog] remote changelog at ${logCount} entries exceeds ceiling ` +
          `${REMOTE_LOG_HARD_CEILING}; waiving ${retentionDays}-day retention and ` +
          `compacting through id ${boundary}. Usually means platform writes were ` +
          `recaptured by remote CDC (see withRemoteSyncMuted).`,
      );
      if (boundary <= compactedThrough) {
        return { compacted: false, reason: "retention_floor" };
      }
    }
    await ensureRemoteCompactionMeta(remote);
    // Marker first, then delete, in one atomic batch: a consumer must never
    // observe deleted entries without the compacted_through_id marker.
    await remote.batch(
      [
        {
          sql:
            `UPDATE ${quoteIdent(SYNC_META_TABLE_NAME)} ` +
            `SET compacted_through_id = ? ` +
            `WHERE id = 1 AND COALESCE(compacted_through_id, 0) < ?`,
          args: [boundary, boundary],
        },
        {
          sql: `DELETE FROM ${quoteIdent(SYNC_LOG_TABLE)} WHERE id <= ?`,
          args: [boundary],
        },
      ],
      "write",
    );
    return {
      compacted: true,
      throughId: boundary,
      ...(ceilingOverride ? { ceilingOverride: true } : {}),
    };
  } catch {
    return { compacted: false, reason: "error" };
  }
}
