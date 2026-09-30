/**
 * Post-delta fingerprint reconcile — snapshot-pull tables that drifted without
 * changelog entries (e.g. cloud snapshot_fallback bulk writes).
 */

import { createHash } from "crypto";
import type { Client } from "@libsql/client";
import type Database from "better-sqlite3";
import { localMissingRemoteTables } from "./tursoDeltaSync.js";
import {
  filterSyncableTables,
  listUserTables,
  quoteIdent,
  readRemoteTable,
  readRemoteTableSchema,
  sortTablesForInsert,
  type LocalTable,
  type TableColumn,
  writeTablesToLocalDb,
} from "./tursoSyncBridgeCore.js";
import {
  ensureLocalSyncInfrastructure,
  ensureLocalTableSyncTriggers,
  readRemoteMaxSyncLogId,
  withSyncMuted,
} from "./tursoSyncLog.js";
import { computeTableFingerprint } from "./tursoTableFingerprint.js";

const FINGERPRINT_VERSION = "v2";
const ROW_BATCH_SIZE = 1_000;

function schemaSignature(columns: TableColumn[]): string {
  return [...columns]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((col) => `${col.name}:${col.type}:${col.primaryKey ? 1 : 0}`)
    .join(",");
}

async function remoteTableExists(
  remote: Client,
  tableName: string,
): Promise<boolean> {
  const result = await remote.execute({
    sql: `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
    args: [tableName],
  });
  return result.rows.length > 0;
}

/** Content fingerprint for a remote table (matches local computeTableFingerprint). */
export async function computeRemoteTableFingerprint(
  remote: Client,
  tableName: string,
): Promise<string | null> {
  if (!(await remoteTableExists(remote, tableName))) {
    return null;
  }

  const columns = await readRemoteTableSchema(remote, tableName);
  const schemaSig = schemaSignature(columns);
  if (columns.length === 0) {
    return `${FINGERPRINT_VERSION}|empty-schema|0`;
  }

  const countResult = await remote.execute(
    `SELECT COUNT(*) AS count FROM ${quoteIdent(tableName)}`,
  );
  const rowCount = Number(countResult.rows[0]?.count ?? 0);

  if (rowCount === 0) {
    return `${FINGERPRINT_VERSION}|${schemaSig}|0`;
  }

  const hash = createHash("sha256");
  hash.update(`${FINGERPRINT_VERSION}|${schemaSig}|${rowCount}|`);

  const colList = columns.map((col) => quoteIdent(col.name)).join(", ");
  let offset = 0;
  while (offset < rowCount) {
    const result = await remote.execute({
      sql:
        `SELECT ${colList} FROM ${quoteIdent(tableName)} ` +
        `ORDER BY rowid LIMIT ? OFFSET ?`,
      args: [ROW_BATCH_SIZE, offset],
    });
    for (const row of result.rows) {
      hash.update(
        JSON.stringify(columns.map((col) => row[col.name] ?? null)),
      );
    }
    if (result.rows.length < ROW_BATCH_SIZE) {
      break;
    }
    offset += ROW_BATCH_SIZE;
  }

  return hash.digest("hex").slice(0, 24);
}

/** Tables whose local fingerprint differs from remote (both must exist on remote). */
export async function findTablesWithFingerprintDrift(
  localDb: Database.Database,
  remote: Client,
  tableNames: readonly string[],
): Promise<string[]> {
  const drifted: string[] = [];
  for (const tableName of tableNames) {
    if (!(await remoteTableExists(remote, tableName))) {
      continue;
    }
    const localFp = computeTableFingerprint(localDb, tableName);
    const remoteFp = await computeRemoteTableFingerprint(remote, tableName);
    if (remoteFp !== null && localFp !== remoteFp) {
      drifted.push(tableName);
    }
  }
  return drifted;
}

async function readRemoteForeignKeyRefsForReconcile(
  remote: Client,
  tableName: string,
  knownNames: ReadonlySet<string>,
): Promise<string[]> {
  const result = await remote.execute(
    `PRAGMA foreign_key_list(${quoteIdent(tableName)})`,
  );
  return result.rows
    .map((row) => String(row.table ?? ""))
    .filter((name) => name.length > 0 && knownNames.has(name));
}

/** Snapshot-pull drifted tables from remote into local (sync-muted). */
export async function reconcileDriftedTablesFromRemote(
  localDb: Database.Database,
  remote: Client,
  tableNames: readonly string[],
): Promise<string[]> {
  if (tableNames.length === 0) {
    return [];
  }

  const tables: LocalTable[] = [];
  for (const tableName of tableNames) {
    tables.push(await readRemoteTable(remote, tableName));
  }

  const knownNames = new Set(tables.map((table) => table.name));
  const foreignKeyRefs = new Map<string, string[]>();
  for (const table of tables) {
    foreignKeyRefs.set(
      table.name,
      await readRemoteForeignKeyRefsForReconcile(remote, table.name, knownNames),
    );
  }
  const orderedTables = sortTablesForInsert(tables, foreignKeyRefs);

  withSyncMuted(localDb, () => {
    writeTablesToLocalDb(localDb, orderedTables);
  });

  return orderedTables.map((table) => table.name);
}

/** After delta pull, reconcile tables updated via snapshot_fallback on cloud. */
export async function reconcileFingerprintDriftAfterDeltaPull(
  localDb: Database.Database,
  remote: Client,
  tableNames: readonly string[],
): Promise<{ reconciledTables: string[] }> {
  const drifted = await findTablesWithFingerprintDrift(
    localDb,
    remote,
    tableNames,
  );
  if (drifted.length === 0) {
    return { reconciledTables: [] };
  }

  const reconciledTables = await reconcileDriftedTablesFromRemote(
    localDb,
    remote,
    drifted,
  );

  console.log(
    `[TursoSync] Reconciled ${reconciledTables.length} table(s) after delta pull: ` +
      `${reconciledTables.join(", ")}`,
  );

  return { reconciledTables };
}

export type BulkPullGate =
  | { action: "full_pull" }
  | { action: "reconcile" }
  | { action: "skip"; reason: string };

/**
 * Block pull paths that would bulk-replace local while unpushed edits exist.
 * Delta merge (LWW) is allowed when mergeWhileLocalDirty is set (Phase 2 bidirectional).
 */
export function shouldBlockPullWhileLocalDirty(input: {
  force?: boolean;
  hadLocalUserTables: boolean;
  localDirty: boolean;
  mergeWhileLocalDirty?: boolean;
}): boolean {
  if (input.mergeWhileLocalDirty === true) {
    return false;
  }
  return (
    input.localDirty &&
    input.hadLocalUserTables &&
    input.force !== true
  );
}

/** Skip snapshot table replace during merge pull — delta + LWW only. */
export function shouldSkipBulkReconcileWhileMerging(input: {
  mergeWhileLocalDirty?: boolean;
  localDirty: boolean;
}): boolean {
  return input.mergeWhileLocalDirty === true && input.localDirty;
}

/** Decide whether routine pull may bulk-replace local tables (Phase 1.1 guard). */
export function evaluateBulkPullGate(input: {
  force: boolean;
  hadLocalUserTables: boolean;
  localDirty: boolean;
  staleConsumer: boolean;
}): BulkPullGate {
  if (input.staleConsumer && input.hadLocalUserTables && input.localDirty) {
    return { action: "skip", reason: "stale_consumer_local_dirty" };
  }

  if (input.force) {
    if (input.hadLocalUserTables && input.localDirty) {
      return { action: "skip", reason: "pull_would_clobber_local" };
    }
    return { action: "full_pull" };
  }

  if (!input.hadLocalUserTables) {
    return { action: "full_pull" };
  }

  if (input.localDirty) {
    return { action: "skip", reason: "pull_would_clobber_local" };
  }

  return { action: "reconcile" };
}

function uniqueTableNames(tableNames: readonly string[]): string[] {
  return [...new Set(tableNames)];
}

/**
 * Pull missing + drifted tables from remote without replacing the whole DB.
 * Advances oplog watermark when remote changelog exists (stale-consumer repair).
 */
export async function repairLocalFromRemoteViaReconcile(
  localDb: Database.Database,
  remote: Client,
  options?: {
    hasRemoteLog?: boolean;
    lastPulledLogId?: number;
  },
): Promise<{ reconciledTables: string[]; lastPulledLogId?: number }> {
  const localTableNames = filterSyncableTables(listUserTables(localDb));
  const missingOnLocal = await localMissingRemoteTables(remote, localTableNames);
  const drifted = await findTablesWithFingerprintDrift(
    localDb,
    remote,
    localTableNames,
  );
  const toReconcile = uniqueTableNames([...missingOnLocal, ...drifted]);

  if (toReconcile.length === 0) {
    return {
      reconciledTables: [],
      ...(options?.lastPulledLogId !== undefined
        ? { lastPulledLogId: options.lastPulledLogId }
        : {}),
    };
  }

  const reconciledTables = await reconcileDriftedTablesFromRemote(
    localDb,
    remote,
    toReconcile,
  );

  let lastPulledLogId = options?.lastPulledLogId;
  if (options?.hasRemoteLog) {
    const remoteMax = await readRemoteMaxSyncLogId(remote);
    if (remoteMax !== undefined && remoteMax > 0) {
      lastPulledLogId = remoteMax;
    }
  }

  console.log(
    `[TursoSync] Repaired ${reconciledTables.length} table(s) via reconcile: ` +
      `${reconciledTables.join(", ")}`,
  );

  return {
    reconciledTables,
    ...(lastPulledLogId !== undefined ? { lastPulledLogId } : {}),
  };
}

/** Install CDC infra on all local syncable tables before reconcile repair. */
export function ensureLocalPullSyncInfrastructure(localDb: Database.Database): void {
  ensureLocalSyncInfrastructure(localDb);
  for (const tableName of filterSyncableTables(listUserTables(localDb))) {
    ensureLocalTableSyncTriggers(localDb, tableName);
  }
}
