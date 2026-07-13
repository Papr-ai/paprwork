/**
 * Row-level CDC changelog for Turso boundary sync.
 * SQLite triggers on user tables append to _papr_sync_log for any writer
 * (Python job, Node, bash, mini-app /api/db/* on desktop).
 */

import type { Client } from "@libsql/client";
import type Database from "better-sqlite3";
import { quoteIdent, readTableSchema, type TableColumn } from "./tursoSyncBridgeCore.js";

export const SYNC_LOG_TABLE = "_papr_sync_log";
export const SYNC_MUTE_TABLE = "_papr_sync_mute";

export const SYNC_INFRA_TABLES = new Set([SYNC_LOG_TABLE, SYNC_MUTE_TABLE]);

export type SyncLogOp = "insert" | "update" | "delete";

export interface SyncLogEntry {
  id: number;
  tableName: string;
  op: SyncLogOp;
  rowPk: unknown[];
}

const MUTE_ROW_ID = 1;
const LOG_BATCH_LIMIT = 10_000;

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

function createSyncMuteTableSql(): string {
  return (
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(SYNC_MUTE_TABLE)} (` +
    `id INTEGER PRIMARY KEY CHECK (id = ${MUTE_ROW_ID}), ` +
    `depth INTEGER NOT NULL DEFAULT 0` +
    `)`
  );
}

export function ensureLocalSyncInfrastructure(db: Database.Database): void {
  db.exec(createSyncLogTableSql());
  db.exec(createSyncMuteTableSql());
  db.exec(
    `INSERT OR IGNORE INTO ${quoteIdent(SYNC_MUTE_TABLE)} (id, depth) VALUES (${MUTE_ROW_ID}, 0)`,
  );
}

export async function ensureRemoteSyncInfrastructure(remote: Client): Promise<void> {
  await remote.execute(createSyncLogTableSql());
  await remote.execute(createSyncMuteTableSql());
  await remote.execute(
    `INSERT OR IGNORE INTO ${quoteIdent(SYNC_MUTE_TABLE)} (id, depth) VALUES (${MUTE_ROW_ID}, 0)`,
  );
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
      `WHEN ${when} ` +
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

export function ensureLocalTableSyncTriggers(
  db: Database.Database,
  tableName: string,
): boolean {
  ensureLocalSyncInfrastructure(db);
  const columns = readTableSchema(db, tableName);
  if (!pkJsonExpr(columns, "NEW")) {
    return false;
  }
  const suffix = triggerSuffix(tableName);
  const insertName = `_papr_tr_${suffix}_ai`;
  if (triggerExists(db, insertName)) {
    return true;
  }
  for (const sql of buildTriggerSql(tableName, suffix, columns)) {
    db.exec(sql);
  }
  return true;
}

export async function ensureRemoteTableSyncTriggers(
  remote: Client,
  columns: TableColumn[],
  tableName: string,
): Promise<boolean> {
  await ensureRemoteSyncInfrastructure(remote);
  if (!pkJsonExpr(columns, "NEW")) {
    return false;
  }
  const suffix = triggerSuffix(tableName);
  const insertName = `_papr_tr_${suffix}_ai`;
  if (await remoteTriggerExists(remote, insertName)) {
    return true;
  }
  for (const sql of buildTriggerSql(tableName, suffix, columns)) {
    await remote.execute(sql);
  }
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
    db.exec(
      `UPDATE ${quoteIdent(SYNC_MUTE_TABLE)} SET depth = depth - 1 WHERE id = ${MUTE_ROW_ID}`,
    );
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
    db.exec(
      `UPDATE ${quoteIdent(SYNC_MUTE_TABLE)} SET depth = depth - 1 WHERE id = ${MUTE_ROW_ID}`,
    );
  }
}

export function readSyncLogSince(
  db: Database.Database,
  afterId: number,
  limit: number = LOG_BATCH_LIMIT,
): SyncLogEntry[] {
  ensureLocalSyncInfrastructure(db);
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

export interface RemoteLogCompactionResult {
  compacted: boolean;
  throughId?: number;
  reason?: string;
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
  await remote.execute(
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(SYNC_META_TABLE_NAME)} ` +
      `(id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL DEFAULT 0, updated_at TEXT)`,
  );
  try {
    await remote.execute(
      `ALTER TABLE ${quoteIdent(SYNC_META_TABLE_NAME)} ` +
        `ADD COLUMN compacted_through_id INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }
  await remote.execute(
    `INSERT OR IGNORE INTO ${quoteIdent(SYNC_META_TABLE_NAME)} (id, version) VALUES (1, 0)`,
  );
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
    const boundary = Number(boundaryResult.rows[0]?.boundary ?? 0);
    if (!Number.isFinite(boundary) || boundary <= compactedThrough) {
      return { compacted: false, reason: "retention_floor" };
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
    return { compacted: true, throughId: boundary };
  } catch {
    return { compacted: false, reason: "error" };
  }
}
