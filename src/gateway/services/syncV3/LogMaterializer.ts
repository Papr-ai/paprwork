/**
 * Apply workspace log entries to local SQLite replicas (Phase 3).
 *
 * Memory server appends to Turso _papr_oplog; desktop materializes row/schema
 * entries onto local data.db files.
 */

import type { AppDataSource } from "../appDataSources.js";
import type { DbQueryPool, WriteResult } from "../DbQueryPool.js";

const DISABLE_FOREIGN_KEYS_SQL = "PRAGMA foreign_keys = OFF";

async function replayRowWrite(
  pool: DbQueryPool,
  appId: string,
  dbPath: string,
  sql: string,
  params?: unknown[],
): Promise<WriteResult> {
  const results = await pool.writeBatch(appId, dbPath, [
    { sql: DISABLE_FOREIGN_KEYS_SQL },
    { sql, params },
  ]);
  const last = results[results.length - 1];
  return last ?? { changes: 0, lastInsertRowid: 0 };
}
import type {
  WorkspaceLogEntry,
  WorkspaceLogRowPayload,
  WorkspaceLogSchemaPayload,
} from "../../../core/types/workspaceLog.js";
import { resolveTursoDatabaseNameForSource } from "../DatabaseRegistryService.js";
import {
  appendWorkspaceLogEntry,
  readWorkspaceLogSince,
} from "./WorkspaceLogClient.js";
import {
  getWorkspaceLogCursor,
  setWorkspaceLogCursor,
} from "./workspaceLogCursor.js";
import { assertReplaySafeRowSql } from "./replaySafeSql.js";
import {
  extractPrimaryTableFromRowSql,
  isPlatformTableName,
} from "./logReplayRowSql.js";
import {
  isSeqMaterialized,
  markSeqMaterialized,
} from "./workspaceLogMaterialized.js";
import {
  applyInlineSchemaSqlLocally,
  applyMigrationSchemaPayloadLocally,
} from "./migrationSchemaLocal.js";
import { isCloudSyncEnabled } from "../../utils/cloudSyncEnabled.js";
import {
  isMissingColumnError,
  isMissingTableError,
  isForeignKeyConstraintError,
} from "../jobs/migrationSqlHelpers.js";
import Database from "better-sqlite3";
import * as fs from "fs";
function isRowPayload(
  payload: WorkspaceLogEntry["payload"],
): payload is WorkspaceLogRowPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "sql" in payload &&
    typeof (payload as WorkspaceLogRowPayload).sql === "string" &&
    !("migrationId" in payload)
  );
}

function isSchemaPayload(
  payload: WorkspaceLogEntry["payload"],
): payload is WorkspaceLogSchemaPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "appId" in payload &&
    typeof (payload as WorkspaceLogSchemaPayload).appId === "string"
  );
}

export function resolveReplicaIdForSource(source: AppDataSource): string | null {
  return resolveTursoDatabaseNameForSource(source);
}

function localUserTableExists(dbPath: string, tableName: string): boolean {
  if (!fs.existsSync(dbPath)) {
    return true;
  }
  const stats = fs.statSync(dbPath);
  if (stats.size === 0) {
    return true;
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
      )
      .get(tableName) as { ok: number } | undefined;
    return Boolean(row?.ok);
  } finally {
    db.close();
  }
}

/**
 * Row ops targeting a user table that no longer exists locally are superseded
 * (e.g. rename/drop applied ahead of log replay). Mark materialized, do not fail.
 */
export function shouldSkipRowReplayForMissingTable(
  dbPath: string,
  sql: string,
): { skip: boolean; tableName: string | null } {
  const tableName = extractPrimaryTableFromRowSql(sql);
  if (!tableName || isPlatformTableName(tableName)) {
    return { skip: false, tableName };
  }
  if (localUserTableExists(dbPath, tableName)) {
    return { skip: false, tableName };
  }
  return { skip: true, tableName };
}

function isDeleteOrUpdateSql(sql: string): boolean {
  return /^\s*(DELETE|UPDATE)\b/i.test(sql.trim());
}

/** Append schema op to server log, then materialize locally. */
export async function appendAndMaterializeSchemaExec(
  pool: DbQueryPool,
  appId: string,
  source: AppDataSource,
  sql: string,
): Promise<void> {
  const replicaId = resolveReplicaIdForSource(source);
  if (!replicaId) {
    throw new Error(
      `Cannot resolve Turso replica for source ${source.alias ?? source.jobId ?? "unknown"}`,
    );
  }

  const appendResult = await appendWorkspaceLogEntry({
    replicaId,
    kind: "schema",
    dbSourceId: source.alias ?? source.jobId,
    payload: { appId, sql },
  });

  if (!(await isSeqMaterialized(pool, appId, source.dbPath, replicaId, appendResult.seq))) {
    await pool.exec(appId, source.dbPath, sql);
    await markSeqMaterialized(pool, appId, source.dbPath, replicaId, appendResult.seq);
  }
  await setWorkspaceLogCursor(replicaId, appendResult.seq);
}

/** Append row op to server log, then materialize locally. */
export async function appendAndMaterializeRowWrite(
  pool: DbQueryPool,
  appId: string,
  source: AppDataSource,
  sql: string,
  params?: unknown[],
): Promise<WriteResult> {
  const replicaId = resolveReplicaIdForSource(source);
  if (!replicaId) {
    throw new Error(
      `Cannot resolve Turso replica for source ${source.alias ?? source.jobId ?? "unknown"}`,
    );
  }

  assertReplaySafeRowSql(sql);

  const appendResult = await appendWorkspaceLogEntry({
    replicaId,
    kind: "row",
    dbSourceId: source.alias ?? source.jobId,
    payload: { appId, sql, params },
  });

  if (await isSeqMaterialized(pool, appId, source.dbPath, replicaId, appendResult.seq)) {
    await setWorkspaceLogCursor(replicaId, appendResult.seq);
    return { changes: 0, lastInsertRowid: 0 };
  }

  const localResult = await replayRowWrite(pool, appId, source.dbPath, sql, params);
  await markSeqMaterialized(pool, appId, source.dbPath, replicaId, appendResult.seq);
  await setWorkspaceLogCursor(replicaId, appendResult.seq);
  return localResult;
}

async function applyLogEntry(
  pool: DbQueryPool,
  source: AppDataSource,
  entry: WorkspaceLogEntry,
  replicaId: string,
): Promise<void> {
  const rowAppId =
    entry.kind === "row" && isRowPayload(entry.payload)
      ? entry.payload.appId
      : undefined;
  const schemaAppId =
    entry.kind === "schema" && isSchemaPayload(entry.payload)
      ? entry.payload.appId
      : undefined;
  const appId = rowAppId ?? schemaAppId ?? entry.dbSourceId ?? "log";

  if (await isSeqMaterialized(pool, appId, source.dbPath, replicaId, entry.seq)) {
    return;
  }

  if (entry.kind === "row" && isRowPayload(entry.payload)) {
    const payload = entry.payload;
    assertReplaySafeRowSql(payload.sql);
    const missingTable = shouldSkipRowReplayForMissingTable(
      source.dbPath,
      payload.sql,
    );
    if (missingTable.skip) {
      console.warn(
        `[LogMaterializer] Skipping superseded row op seq=${entry.seq} ` +
          `(table ${missingTable.tableName ?? "unknown"} no longer exists locally)`,
      );
      await markSeqMaterialized(
        pool,
        payload.appId,
        source.dbPath,
        replicaId,
        entry.seq,
      );
      return;
    }
    try {
      await replayRowWrite(
        pool,
        payload.appId,
        source.dbPath,
        payload.sql,
        payload.params,
      );
    } catch (error) {
      if (isMissingTableError(error)) {
        console.warn(
          `[LogMaterializer] Skipping superseded row op seq=${entry.seq} ` +
            `(table missing: ${(error as Error).message.slice(0, 120)})`,
        );
        await markSeqMaterialized(
          pool,
          payload.appId,
          source.dbPath,
          replicaId,
          entry.seq,
        );
        return;
      }
      if (
        isForeignKeyConstraintError(error) &&
        isDeleteOrUpdateSql(payload.sql)
      ) {
        console.warn(
          `[LogMaterializer] Skipping superseded row op seq=${entry.seq} ` +
            `(FK constraint on ${payload.sql.trim().slice(0, 80)})`,
        );
        await markSeqMaterialized(
          pool,
          payload.appId,
          source.dbPath,
          replicaId,
          entry.seq,
        );
        return;
      }
      throw error;
    }
    await markSeqMaterialized(pool, payload.appId, source.dbPath, replicaId, entry.seq);
    return;
  }
  if (entry.kind === "schema" && isSchemaPayload(entry.payload)) {
    const schemaPayload = entry.payload;
    const schemaApp = schemaPayload.appId ?? entry.dbSourceId ?? "schema";
    const db = new Database(source.dbPath);
    db.pragma("foreign_keys = OFF");
    try {
      if (schemaPayload.migrationId?.trim()) {
        applyMigrationSchemaPayloadLocally(db, schemaPayload);
      } else if (schemaPayload.sql?.trim()) {
        applyInlineSchemaSqlLocally(db, schemaPayload.sql);
      }
    } catch (error) {
      if (isMissingTableError(error) || isMissingColumnError(error)) {
        console.warn(
          `[LogMaterializer] Skipping superseded schema op seq=${entry.seq} ` +
            `(${(error as Error).message.slice(0, 120)})`,
        );
      } else {
        throw error;
      }
    } finally {
      db.close();
    }
    await markSeqMaterialized(pool, schemaApp, source.dbPath, replicaId, entry.seq);
    return;
  }
  if (entry.kind === "snapshot") {
    return;
  }
}

/** Catch up from persisted cursor — idempotent by seq ordering. */
export async function materializeWorkspaceLogSince(
  pool: DbQueryPool,
  replicaId: string,
  source: AppDataSource,
): Promise<number> {
  const { shouldSuppressLegacyTursoPushForLinkedSource } = await import(
    "../tursoReplica/tursoReplicaRouting.js"
  );
  if (shouldSuppressLegacyTursoPushForLinkedSource(source)) {
    return 0;
  }

  let cursor = await getWorkspaceLogCursor(replicaId);
  let applied = 0;

  for (;;) {
    const page = await readWorkspaceLogSince(replicaId, cursor, 200);
    if (page.entries.length === 0) {
      break;
    }
    for (const entry of page.entries) {
      await applyLogEntry(pool, source, entry, replicaId);
      cursor = entry.seq;
      applied += 1;
    }
    await setWorkspaceLogCursor(replicaId, cursor);
    if (!page.hasMore) {
      break;
    }
  }

  return applied;
}

/**
 * Interactive /api/db/write uses local-first + async log ship when true.
 * Log replay / catch-up paths still use appendAndMaterialize* directly.
 */
export function isWorkspaceLogRowsEnabled(): boolean {
  return isCloudSyncEnabled();
}
