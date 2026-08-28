/**
 * Drift-heal: ship unsatisfied migrations and column-diff ops via workspace log.
 */

import { createClient, type Client } from "@libsql/client";
import Database from "better-sqlite3";
import {
  filterSyncableTables,
  listUserTables,
  quoteIdent,
  readRemoteTableSchema,
  readTableSchema,
  type TableColumn,
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
import { linkedSourceAsAppDataSource } from "../tursoLinkedSources.js";
import { ensureTursoSyncBridge } from "../TursoSyncBridge.js";
import { yieldEventLoop } from "../cloudSync/yieldEventLoop.js";
import {
  shipSchemaDriftHealPayload,
  shipSchemaMigrationBatch,
  shipSchemaMigrationForDbPath,
} from "./shipSchemaMigrationLog.js";
import { computeSchemaPayloadContentHash } from "../jobs/migrationContentHash.js";
import { isSyncV3SchemaLogEnabled } from "./syncV3Flags.js";
import { resolveReplicaIdForLinkedSource } from "./workspaceLogSync.js";

const DRIFT_HEAL_PREFIX = "__schema_drift_heal__";

function linkedSourceLabel(linked: TursoLinkedSource): string {
  return linked.alias ?? linked.jobId ?? linked.dbId ?? linked.dbPath;
}

async function openRemoteClient(
  linked: TursoLinkedSource,
): Promise<{ remote: Client; close: () => void } | null> {
  const replicaId = resolveReplicaIdForLinkedSource(linked);
  if (!replicaId) {
    return null;
  }
  const bridge = ensureTursoSyncBridge();
  if (!bridge.enabled) {
    return null;
  }
  const credentials = await bridge.fetchCredentials(replicaId);
  const remote = createClient({
    url: credentials.tursoUrl,
    authToken: credentials.authToken,
  });
  return { remote, close: () => remote.close() };
}

async function withRemoteClient<T>(
  linked: TursoLinkedSource,
  operation: (remote: Client) => Promise<T>,
): Promise<T | null> {
  const handle = await openRemoteClient(linked);
  if (!handle) {
    return null;
  }
  try {
    return await operation(handle.remote);
  } finally {
    handle.close();
  }
}

const REBUILD_SUFFIX = "__papr_rebuild";
const OLD_SUFFIX = "__papr_old";

/**
 * Rebuilds are expensive (they copy every row) and the remote apply is capped
 * by a timeout. Shipping several in one payload means a slow table starves the
 * rest and the whole payload is retried from the start each sync, so nothing
 * ever converges. One per pass converges steadily instead.
 */
const MAX_REBUILDS_PER_PASS = 1;

/** Scaffolding left behind by an interrupted rebuild. */
function staleRebuildCleanupOps(tableName: string): JobMigrationSchemaOp[] {
  return [
    `DROP TABLE IF EXISTS ${quoteIdent(`${tableName}${REBUILD_SUFFIX}`)}`,
    `DROP TABLE IF EXISTS ${quoteIdent(`${tableName}${OLD_SUFFIX}`)}`,
  ].map((statement) => ({ kind: "sql" as const, statement }));
}

function columnDefinition(col: TableColumn, inlinePk: boolean): string {
  const type = col.type.trim() || "TEXT";
  return `${quoteIdent(col.name)} ${type}${inlinePk ? " PRIMARY KEY" : ""}`;
}

/**
 * Rebuild a remote table so its column types and PRIMARY KEY match local.
 *
 * SQLite cannot ALTER a column's type or add a PRIMARY KEY to an existing
 * table, so a copy-and-swap is the only way to express this drift. Without it
 * the healer produced zero ops for PK/type drift: the table was reported
 * drifted forever, and publish stayed blocked no matter how many times the
 * user pressed Upload.
 *
 * These statements run against Turso only — local is already the source of
 * truth for the schema we are converging on.
 */
function buildRemoteTableRebuildOps(
  tableName: string,
  localColumns: readonly TableColumn[],
  remoteColumns: readonly TableColumn[],
): JobMigrationSchemaOp[] {
  const temp = `${tableName}${REBUILD_SUFFIX}`;
  const pkCols = localColumns.filter((col) => col.primaryKey);
  const singlePk = pkCols.length === 1;

  const colDefs = localColumns
    .map((col) => columnDefinition(col, singlePk && col.primaryKey))
    .join(", ");
  const compositePk =
    pkCols.length > 1
      ? `, PRIMARY KEY (${pkCols.map((col) => quoteIdent(col.name)).join(", ")})`
      : "";

  // Only copy columns the remote actually has; anything else would fail to
  // resolve in the SELECT and abort the whole rebuild.
  const remoteNames = new Set(remoteColumns.map((col) => col.name));
  const carried = localColumns
    .filter((col) => remoteNames.has(col.name))
    .map((col) => quoteIdent(col.name))
    .join(", ");

  const statements = [
    // A previous interrupted rebuild would otherwise block CREATE.
    `DROP TABLE IF EXISTS ${quoteIdent(temp)}`,
    `CREATE TABLE ${quoteIdent(temp)} (${colDefs}${compositePk})`,
  ];
  if (carried.length > 0) {
    // OR IGNORE: the drifted table had no PRIMARY KEY, so it may hold
    // duplicate keys that the rebuilt table legitimately rejects.
    statements.push(
      `INSERT OR IGNORE INTO ${quoteIdent(temp)} (${carried}) SELECT ${carried} FROM ${quoteIdent(tableName)}`,
    );
  }
  // Swap by renaming rather than DROP-then-RENAME.
  //
  // These statements are applied one at a time on the remote and the run can
  // be cut short by a timeout. DROP TABLE followed by ALTER ... RENAME leaves
  // a window in which the real table has been destroyed and its replacement
  // has not been installed: if the run dies there, the table is simply gone
  // from the replica and the web app 500s with "no such table" until a later
  // sync recreates it. Observed repeatedly on a slow link — a different table
  // vanished on each attempt.
  //
  // Renaming the original aside first keeps the data reachable the whole time.
  // The only gap is between two metadata-only renames, and a run that dies in
  // it leaves the rows in `__papr_old` rather than deleting them.
  const old = `${tableName}${OLD_SUFFIX}`;
  statements.push(`DROP TABLE IF EXISTS ${quoteIdent(old)}`);
  statements.push(`ALTER TABLE ${quoteIdent(tableName)} RENAME TO ${quoteIdent(old)}`);
  statements.push(
    `ALTER TABLE ${quoteIdent(temp)} RENAME TO ${quoteIdent(tableName)}`,
  );
  statements.push(`DROP TABLE IF EXISTS ${quoteIdent(old)}`);

  return statements.map((statement) => ({ kind: "sql" as const, statement }));
}

/** Columns present on both sides whose type or PK flag disagrees. */
function incompatibleColumns(
  localColumns: readonly TableColumn[],
  remoteColumns: readonly TableColumn[],
): TableColumn[] {
  const remoteByName = new Map(remoteColumns.map((col) => [col.name, col]));
  return localColumns.filter((localCol) => {
    const remoteCol = remoteByName.get(localCol.name);
    if (!remoteCol) {
      return false; // handled by add_column
    }
    const typeDiffers =
      (localCol.type.trim() || "TEXT").toUpperCase() !==
      (remoteCol.type.trim() || "TEXT").toUpperCase();
    return typeDiffers || localCol.primaryKey !== remoteCol.primaryKey;
  });
}

async function buildColumnDriftHealOps(
  remote: Client,
  localDb: Database.Database,
  driftedTables: readonly string[],
): Promise<JobMigrationSchemaOp[]> {
  const ops: JobMigrationSchemaOp[] = [];
  let rebuilds = 0;
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
        // The table may be missing because an earlier rebuild was interrupted,
        // in which case its scaffolding is still there holding a stale copy.
        ops.push(...staleRebuildCleanupOps(tableName));
        const statement = ddl.toLowerCase().includes("if not exists")
          ? ddl
          : ddl.replace(/^create table/i, "CREATE TABLE IF NOT EXISTS");
        ops.push({ kind: "sql", statement });
      }
      continue;
    }

    const localAll = readTableSchema(localDb, tableName);
    const remoteAll = await readRemoteTableSchema(remote, tableName);
    const localCols = userSchemaColumns(localAll);
    const remoteCols = userSchemaColumns(remoteAll);

    // Type/PK differences cannot be expressed as ALTER TABLE, so a table that
    // drifts that way needs a full rebuild. Emitting add_column ops here (or
    // nothing at all) leaves the table permanently drifted.
    if (incompatibleColumns(localCols, remoteCols).length > 0) {
      if (rebuilds >= MAX_REBUILDS_PER_PASS) {
        // Leave the rest for the next pass rather than building a payload too
        // large to finish; a truncated payload heals nothing and is retried
        // whole, so batching them makes convergence slower, not faster.
        continue;
      }
      rebuilds += 1;
      ops.push(...buildRemoteTableRebuildOps(tableName, localAll, remoteAll));
      continue;
    }

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

async function listUnsatisfiedMigrationIds(
  remote: Client,
  linked: TursoLinkedSource,
): Promise<string[]> {
  const dbPath = linked.dbPath;
  const migrationRoot = resolveMigrationRootFromDbPath(dbPath);
  if (!migrationRoot) {
    return [];
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
      remote,
      migrationRoot,
      migrationId,
    );
    if (!satisfied) {
      unsatisfied.push(migrationId);
    }
  }
  return unsatisfied;
}

/** Ship schema log entries for locally applied migrations not satisfied on Turso. */
export async function shipUnsatisfiedSchemaMigrations(
  linked: TursoLinkedSource,
): Promise<number> {
  if (!isSyncV3SchemaLogEnabled()) {
    return 0;
  }
  const dbPath = linked.dbPath;
  const unsatisfied = await withRemoteClient(linked, (remote) =>
    listUnsatisfiedMigrationIds(remote, linked),
  );
  if (!unsatisfied || unsatisfied.length === 0) {
    return 0;
  }

  return shipSchemaMigrationForDbPath(linked, dbPath, unsatisfied);
}

async function buildDriftHealOpsIfNeeded(
  remote: Client,
  linked: TursoLinkedSource,
): Promise<JobMigrationSchemaOp[]> {
  const dbPath = linked.dbPath;
  const localDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tableNames = filterSyncableTables(listUserTables(localDb));
    const driftedTables = await localRemoteUserSchemaDriftTables(
      remote,
      localDb,
      tableNames,
    );
    if (driftedTables.length === 0) {
      return [];
    }
    return await buildColumnDriftHealOps(remote, localDb, driftedTables);
  } finally {
    localDb.close();
  }
}

/** Ship column-diff heal ops when migrations are ledger-satisfied but schema still drifts. */
export async function healSchemaDriftIfNeeded(
  linked: TursoLinkedSource,
): Promise<number> {
  if (!isSyncV3SchemaLogEnabled()) {
    return 0;
  }
  const ops = await withRemoteClient(linked, (remote) =>
    buildDriftHealOpsIfNeeded(remote, linked),
  );
  if (!ops || ops.length === 0) {
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
    // MUST await before the finally closes the client.
    //
    // `return promise` inside try/finally resolves the promise AFTER the
    // finally block runs, so the local DB and the libSQL client were both
    // closed while the drift scan was still issuing queries against them.
    // The scan then died with "Client was manually closed" and the whole
    // push reported failed — on every attempt, for any app whose replica
    // had drifted.
    return await localRemoteUserSchemaDriftTables(
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

export async function runSchemaDriftHeal(
  linked: TursoLinkedSource,
): Promise<number> {
  const { shouldSuppressLegacyTursoPushForLinkedSource } = await import(
    "../tursoReplica/tursoReplicaRouting.js"
  );
  if (shouldSuppressLegacyTursoPushForLinkedSource(linkedSourceAsAppDataSource(linked))) {
    return 0;
  }

  if (!isSyncV3SchemaLogEnabled()) {
    return 0;
  }

  const label = linkedSourceLabel(linked);
  console.log(`[SchemaDriftHeal] Starting for ${label}`);

  const remoteWork = await withRemoteClient(linked, async (remote) => {
    const migrationRoot = resolveMigrationRootFromDbPath(linked.dbPath);
    if (migrationRoot) {
      console.log(`[SchemaDriftHeal] Phase alignMigrationLedgers for ${label}`);
      await alignMigrationLedgers(remote, linked.dbPath, migrationRoot);
      await yieldEventLoop();
    }

    console.log(
      `[SchemaDriftHeal] Phase listUnsatisfiedMigrationIds for ${label}`,
    );
    const unsatisfied = await listUnsatisfiedMigrationIds(remote, linked);
    if (unsatisfied.length > 0) {
      console.log(
        `[SchemaDriftHeal] Unsatisfied migrations for ${label}: ${unsatisfied.join(", ")}`,
      );
    }

    console.log(`[SchemaDriftHeal] Phase buildDriftHealOps for ${label}`);
    const healOps = await buildDriftHealOpsIfNeeded(remote, linked);
    if (healOps.length > 0) {
      console.log(
        `[SchemaDriftHeal] Column heal ops for ${label}: ${healOps.length}`,
      );
    }

    return { unsatisfied, healOps };
  });

  if (!remoteWork) {
    console.warn(
      `[SchemaDriftHeal] Skipped ${label} — Turso remote client unavailable`,
    );
    return 0;
  }

  let shipped = 0;
  const migrationCount = remoteWork.unsatisfied.length;
  const healCount = remoteWork.healOps.length > 0 ? 1 : 0;
  const batchCount = migrationCount + healCount;

  if (batchCount > 0) {
    if (linked.appId) {
      const { reportFlushProgress } = await import(
        "../cloudSync/flushProgress.js"
      );
      const detail =
        batchCount === 1
          ? "Applying one database schema update on the web. Large tables can take a few minutes."
          : `Applying ${batchCount} database schema updates on the web. Large tables can take a few minutes.`;
      await reportFlushProgress(linked.appId, {
        layer: "turso",
        label: "Applying database migrations…",
        detail,
      });
    }

    console.log(
      `[SchemaDriftHeal] Shipping ${batchCount} schema entry(ies) in one batch for ${label}`,
    );
    shipped = await shipSchemaMigrationBatch(
      linked,
      linked.dbPath,
      remoteWork.unsatisfied,
      remoteWork.healOps.length > 0 ? remoteWork.healOps : undefined,
    );
    await yieldEventLoop();
  } else {
    console.log(`[SchemaDriftHeal] Nothing to ship for ${label}`);
  }

  if (shipped > 0) {
    console.log(
      `[SchemaDriftHeal] Memory applied ${shipped} schema entry(ies) for ${label}`,
    );
  }

  return shipped;
}
