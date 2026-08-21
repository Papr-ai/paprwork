/**
 * Drift-heal: ship unsatisfied migrations and column-diff ops via workspace log.
 */

import { createClient, type Client } from "@libsql/client";
import Database from "better-sqlite3";
import {
  filterSyncableTables,
  listUserTables,
  readRemoteTableSchema,
  readTableSchema,
} from "../tursoSyncBridgeCore.js";
import type { JobMigrationSchemaOp } from "../../../core/types/jobMigrations.js";
import { resolveMigrationRootFromDbPath } from "../jobs/databaseMigrations.js";
import { migrationSatisfiedOnRemote } from "../jobs/jobMigrationLedgerSync.js";
import {
  normalizeMigrationIdList,
} from "../jobs/migrationIdNormalize.js";
import {
  migrationHasExecutableOps,
  shouldSkipMigrationForRemoteLedger,
} from "../jobs/migrationLedgerPolicy.js";
import { listAppliedMigrationIdsReadOnly } from "../jobs/schemaMigrationsLedger.js";
import { alignMigrationLedgers } from "../jobs/jobMigrationLedgerSync.js";
import { localRemoteUserSchemaDriftTables } from "../tursoDeltaSync.js";
import { userSchemaColumns } from "../tursoTableFingerprint.js";
import type { TursoLinkedSource } from "../tursoLinkedSources.js";
import { getTursoSyncBridge } from "../TursoSyncBridge.js";
import { yieldEventLoop } from "../cloudSync/yieldEventLoop.js";
import {
  shipSchemaDriftHealPayload,
  shipSchemaMigrationForDbPath,
} from "./shipSchemaMigrationLog.js";
import { computeSchemaPayloadContentHash } from "../jobs/migrationContentHash.js";
import { isSyncV3SchemaLogEnabled } from "./syncV3Flags.js";
import { resolveReplicaIdForLinkedSource } from "./workspaceLogSync.js";

const DRIFT_HEAL_PREFIX = "__schema_drift_heal__";

async function openRemoteClient(
  linked: TursoLinkedSource,
): Promise<{ remote: Client; close: () => void } | null> {
  const replicaId = resolveReplicaIdForLinkedSource(linked);
  if (!replicaId) {
    return null;
  }
  const bridge = getTursoSyncBridge();
  if (!bridge) {
    return null;
  }
  const credentials = await bridge.fetchCredentials(replicaId);
  const remote = createClient({
    url: credentials.tursoUrl,
    authToken: credentials.authToken,
  });
  return { remote, close: () => remote.close() };
}

async function buildColumnDriftHealOps(
  remote: Client,
  localDb: Database.Database,
  driftedTables: readonly string[],
): Promise<JobMigrationSchemaOp[]> {
  const ops: JobMigrationSchemaOp[] = [];
  for (const tableName of driftedTables) {
    const exists = await remote.execute({
      sql: `SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`,
      args: [tableName],
    });
    if (exists.rows.length === 0) {
      const ddlRow = localDb
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`,
        )
        .get(tableName) as { sql?: string } | undefined;
      const ddl = ddlRow?.sql?.trim();
      if (ddl) {
        const statement = ddl.toLowerCase().includes("if not exists")
          ? ddl
          : ddl.replace(/^create table/i, "CREATE TABLE IF NOT EXISTS");
        ops.push({ kind: "sql", statement });
      }
      continue;
    }

    const localCols = userSchemaColumns(readTableSchema(localDb, tableName));
    const remoteCols = userSchemaColumns(
      await readRemoteTableSchema(remote, tableName),
    );
    const remoteNames = new Set(remoteCols.map((col) => col.name));
    for (const localCol of localCols) {
      if (!remoteNames.has(localCol.name)) {
        ops.push({
          kind: "add_column",
          table: tableName,
          column: localCol.name,
          type: localCol.type.trim() || "TEXT",
        });
      }
    }
  }
  return ops;
}

/** Ship schema log entries for locally applied migrations not satisfied on Turso. */
export async function shipUnsatisfiedSchemaMigrations(
  linked: TursoLinkedSource,
): Promise<number> {
  if (!isSyncV3SchemaLogEnabled()) {
    return 0;
  }
  const dbPath = linked.dbPath;
  const migrationRoot = resolveMigrationRootFromDbPath(dbPath);
  if (!migrationRoot) {
    return 0;
  }

  const remoteHandle = await openRemoteClient(linked);
  if (!remoteHandle) {
    return 0;
  }

  let localApplied: string[] = [];
  const localDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    localApplied = normalizeMigrationIdList(
      listAppliedMigrationIdsReadOnly(localDb),
    );
  } finally {
    localDb.close();
  }

  const unsatisfied: string[] = [];
  try {
    for (const migrationId of localApplied) {
      if (shouldSkipMigrationForRemoteLedger(migrationId)) {
        continue;
      }
      const hasExecutable = await migrationHasExecutableOps(
        migrationRoot,
        migrationId,
      );
      if (!hasExecutable) {
        continue;
      }
      const satisfied = await migrationSatisfiedOnRemote(
        remoteHandle.remote,
        migrationRoot,
        migrationId,
      );
      if (!satisfied) {
        unsatisfied.push(migrationId);
      }
    }
  } finally {
    remoteHandle.close();
  }

  if (unsatisfied.length === 0) {
    return 0;
  }

  return shipSchemaMigrationForDbPath(linked, dbPath, unsatisfied);
}

/** Ship column-diff heal ops when migrations are ledger-satisfied but schema still drifts. */
export async function healSchemaDriftIfNeeded(
  linked: TursoLinkedSource,
): Promise<number> {
  if (!isSyncV3SchemaLogEnabled()) {
    return 0;
  }
  const dbPath = linked.dbPath;
  const remoteHandle = await openRemoteClient(linked);
  if (!remoteHandle) {
    return 0;
  }

  const localDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  let driftedTables: string[] = [];
  try {
    const tableNames = filterSyncableTables(listUserTables(localDb));
    driftedTables = await localRemoteUserSchemaDriftTables(
      remoteHandle.remote,
      localDb,
      tableNames,
    );
  } finally {
    localDb.close();
    remoteHandle.close();
  }

  if (driftedTables.length === 0) {
    return 0;
  }

  const remoteHandle2 = await openRemoteClient(linked);
  if (!remoteHandle2) {
    return 0;
  }
  const localDb2 = new Database(dbPath, { readonly: true, fileMustExist: true });
  let ops: JobMigrationSchemaOp[] = [];
  try {
    ops = await buildColumnDriftHealOps(
      remoteHandle2.remote,
      localDb2,
      driftedTables,
    );
  } finally {
    localDb2.close();
    remoteHandle2.close();
  }

  if (ops.length === 0) {
    return 0;
  }

  const migrationId = `${DRIFT_HEAL_PREFIX}_${Date.now()}`;
  const contentHash = computeSchemaPayloadContentHash({
    migrationId,
    ops,
    statements: null,
  });
  const shipped = await shipSchemaDriftHealPayload(
    linked,
    migrationId,
    contentHash,
    ops,
  );
  return shipped ? 1 : 0;
}

async function listDriftedTableNames(
  linked: TursoLinkedSource,
): Promise<string[]> {
  const dbPath = linked.dbPath;
  const remoteHandle = await openRemoteClient(linked);
  if (!remoteHandle) {
    return [];
  }
  const localDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tableNames = filterSyncableTables(listUserTables(localDb));
    return localRemoteUserSchemaDriftTables(
      remoteHandle.remote,
      localDb,
      tableNames,
    );
  } finally {
    localDb.close();
    remoteHandle.close();
  }
}

/**
 * After schema log append, memory server should apply DDL to Turso before HTTP 200.
 * Poll until local/remote schemas match (or timeout) so webReady does not race the apply.
 */
export async function waitForLinkedSourceSchemaConvergence(
  linked: TursoLinkedSource,
  options?: { maxWaitMs?: number; pollMs?: number },
): Promise<{ converged: boolean; driftedTables: string[] }> {
  const maxWaitMs = options?.maxWaitMs ?? 30_000;
  const pollMs = options?.pollMs ?? 750;
  const deadline = Date.now() + maxWaitMs;
  const syncKey = linked.alias ?? linked.jobId ?? linked.dbId ?? "unknown";

  while (Date.now() < deadline) {
    const driftedTables = await listDriftedTableNames(linked);
    if (driftedTables.length === 0) {
      return { converged: true, driftedTables: [] };
    }
    await yieldEventLoop();
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  const driftedTables = await listDriftedTableNames(linked);
  if (driftedTables.length > 0) {
    console.warn(
      `[SchemaDriftHeal] Turso schema still drifted for ${syncKey} after ${maxWaitMs}ms: ${driftedTables.join(", ")}`,
    );
  }
  return { converged: driftedTables.length === 0, driftedTables };
}

/** Backfill ledgers when Turso already has tables from legacy sync (avoid re-shipping DDL). */
async function alignMigrationLedgersIfNeeded(
  linked: TursoLinkedSource,
): Promise<void> {
  const migrationRoot = resolveMigrationRootFromDbPath(linked.dbPath);
  if (!migrationRoot) {
    return;
  }
  const remoteHandle = await openRemoteClient(linked);
  if (!remoteHandle) {
    return;
  }
  try {
    await alignMigrationLedgers(
      remoteHandle.remote,
      linked.dbPath,
      migrationRoot,
    );
  } finally {
    remoteHandle.close();
  }
  await yieldEventLoop();
}

export async function runSchemaDriftHeal(
  linked: TursoLinkedSource,
): Promise<number> {
  await alignMigrationLedgersIfNeeded(linked);

  let shipped = 0;
  shipped += await shipUnsatisfiedSchemaMigrations(linked);
  await yieldEventLoop();
  shipped += await healSchemaDriftIfNeeded(linked);

  if (shipped > 0) {
    await waitForLinkedSourceSchemaConvergence(linked);
  }

  return shipped;
}
