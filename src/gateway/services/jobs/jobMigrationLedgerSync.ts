/**
 * Keep migration ledgers aligned across local SQLite, Turso remote, and cloud sandbox.
 *
 * User tables sync via Turso CDC; `schema_migrations` and `_papr_schema_migrations`
 * are scratch tables and never row-sync. This module bridges that gap:
 * - Turso `_papr_schema_migrations` is authoritative for "what ran on remote"
 * - Local `schema_migrations` is hydrated from remote on pull and from local schema inference
 * - Remote ledger is backfilled when schema already matches (legacy / drift-fixed DBs)
 */

import type { Client } from "@libsql/client";
import Database from "better-sqlite3";
import type { JobMigrationSchemaOp } from "../../../core/types/jobMigrations.js";
import { quoteIdent } from "../tursoSyncBridgeCore.js";
import {
  ensureSchemaMigrationsTable,
  listAppliedMigrationIdsReadOnly,
} from "../jobs/schemaMigrationsLedger.js";
import { localTableHasColumn } from "./databaseMigrations.js";
import {
  listMigrationSqlFiles,
  loadJobMigrationManifest,
  manifestEntryById,
  readMigrationSql,
} from "./jobMigrationManifest.js";
import { shouldSkipMigrationForRemoteLedger } from "./migrationLedgerPolicy.js";
import {
  parseAddColumnStatement,
  parseCreateIndexStatement,
  parseCreateTableStatement,
  parseDropStatement,
  parseRenameTableStatement,
  splitSqlStatements,
} from "./migrationSqlHelpers.js";

export const REMOTE_SCHEMA_MIGRATIONS_TABLE = "_papr_schema_migrations";

/**
 * Outcome of checking one schema op.
 *
 * `unknown` = the statement is a shape we cannot introspect. Treating it as
 * `unsatisfied` makes verification fail permanently, so callers warn instead.
 */
type SchemaOpCheck = "satisfied" | "unsatisfied" | "unknown";

export interface MigrationVerification {
  satisfied: boolean;
  /** Statements we could not introspect — surfaced as warnings, never failures. */
  unverifiable: string[];
}

function toCheck(value: boolean): SchemaOpCheck {
  return value ? "satisfied" : "unsatisfied";
}

function describeOp(op: JobMigrationSchemaOp): string {
  const raw = op.kind === "sql" ? op.statement : `${op.kind} ${op.table}`;
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length > 120 ? `${collapsed.slice(0, 117)}…` : collapsed;
}

/** Name of the table/index a statement creates, for supersede detection. */
function createdObject(
  op: JobMigrationSchemaOp,
): { objectType: "table" | "index"; name: string } | null {
  if (op.kind !== "sql") {
    return null;
  }
  const table = parseCreateTableStatement(op.statement);
  if (table) {
    return { objectType: "table", name: table.table };
  }
  const index = parseCreateIndexStatement(op.statement);
  if (index) {
    return { objectType: "index", name: index.indexName };
  }
  return null;
}

/**
 * Drop-and-recreate is a normal migration shape:
 *
 *   DROP INDEX IF EXISTS idx_a;
 *   CREATE INDEX idx_a ON t (a, b);
 *
 * Checked per statement the DROP looks unsatisfied, because the object exists
 * again by the time we verify. Only the final state matters, so ignore a DROP
 * that a later statement in the same migration re-creates.
 */
function isSupersededDrop(
  ops: readonly JobMigrationSchemaOp[],
  index: number,
): boolean {
  const op = ops[index];
  if (op.kind !== "sql") {
    return false;
  }
  const drop = parseDropStatement(op.statement);
  if (!drop) {
    return false;
  }
  return ops.slice(index + 1).some((later) => {
    const created = createdObject(later);
    return (
      created !== null &&
      created.objectType === drop.objectType &&
      created.name === drop.name
    );
  });
}

/**
 * Was the object this statement acts on renamed away later in the migration?
 *
 * Table rebuilds (the only way to change a column type or add a PRIMARY KEY in
 * SQLite) are expressed as copy-and-swap:
 *
 *   CREATE TABLE t__papr_rebuild (…)      -- new shape
 *   INSERT INTO t__papr_rebuild SELECT …  -- carry rows over
 *   ALTER TABLE t RENAME TO t__papr_old
 *   ALTER TABLE t__papr_rebuild RENAME TO t
 *   DROP TABLE IF EXISTS t__papr_old
 *
 * Verifying statement-by-statement afterwards, the CREATE looks unsatisfied:
 * `t__papr_rebuild` is gone, because it *became* `t`. That verdict is
 * permanent — the name can never come back — so cloud sync wedges and every
 * retry fails identically.
 *
 * Only the final state matters, so a statement whose object is renamed away by
 * a later statement in the same migration is skipped. The rename target is
 * itself verified when the loop reaches the statement that creates it.
 */
function isSupersededByRename(
  ops: readonly JobMigrationSchemaOp[],
  index: number,
): boolean {
  const op = ops[index];
  const subject =
    createdObject(op) ??
    (op.kind === "sql"
      ? (() => {
          const rename = parseRenameTableStatement(op.statement);
          return rename
            ? { objectType: "table" as const, name: rename.to }
            : null;
        })()
      : null);
  if (!subject || subject.objectType !== "table") {
    return false;
  }
  return ops.slice(index + 1).some((later) => {
    if (later.kind !== "sql") {
      return false;
    }
    const rename = parseRenameTableStatement(later.statement);
    return rename !== null && rename.from === subject.name;
  });
}

/**
 * A statement is irrelevant to final state when a later statement in the same
 * migration overwrites its effect. Checking these individually is what made
 * table rebuilds fail verification forever.
 */
function isSuperseded(
  ops: readonly JobMigrationSchemaOp[],
  index: number,
): boolean {
  return isSupersededDrop(ops, index) || isSupersededByRename(ops, index);
}

function warnUnverifiable(
  migrationRoot: string,
  migrationId: string,
  target: string,
  unverifiable: readonly string[],
): void {
  if (unverifiable.length === 0) {
    return;
  }
  console.warn(
    `[MigrationLedger] ${migrationId} (${migrationRoot}): ` +
      `${unverifiable.length} statement(s) could not be verified on ${target} ` +
      `and were treated as satisfied: ${unverifiable.join(" | ")}`,
  );
}

async function ensureRemoteSchemaMigrationsTable(
  remote: Client,
): Promise<void> {
  await remote.execute(
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(REMOTE_SCHEMA_MIGRATIONS_TABLE)} (` +
      `id TEXT PRIMARY KEY, ` +
      `applied_at TEXT NOT NULL, ` +
      `source TEXT NOT NULL DEFAULT 'database_migration'` +
      `)`,
  );
}

export interface MigrationLedgerSyncResult {
  remoteBackfilled: string[];
  localHydrated: string[];
  localInferred: string[];
}

function listLocalAppliedMigrationIds(localDb: Database.Database): string[] {
  return listAppliedMigrationIdsReadOnly(localDb);
}

export async function listRemoteAppliedMigrationIds(
  remote: Client,
): Promise<Set<string>> {
  await ensureRemoteSchemaMigrationsTable(remote);
  const result = await remote.execute(
    `SELECT id FROM ${quoteIdent(REMOTE_SCHEMA_MIGRATIONS_TABLE)}`,
  );
  return new Set(
    result.rows.map((row) => String(row.id ?? "")).filter((id) => id.length > 0),
  );
}

async function recordRemoteMigrationApplied(
  remote: Client,
  migrationId: string,
): Promise<void> {
  await remote.execute({
    sql:
      `INSERT OR IGNORE INTO ${quoteIdent(REMOTE_SCHEMA_MIGRATIONS_TABLE)} ` +
      `(id, applied_at, source) VALUES (?, datetime('now'), 'database_migration')`,
    args: [migrationId],
  });
}

async function remoteTableHasColumn(
  remote: Client,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const result = await remote.execute(
    `PRAGMA table_info(${quoteIdent(tableName)})`,
  );
  return result.rows.some((row) => String(row.name ?? "") === columnName);
}

export async function remoteTableExists(
  remote: Client,
  tableName: string,
): Promise<boolean> {
  const result = await remote.execute({
    sql: `SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`,
    args: [tableName],
  });
  return result.rows.length > 0;
}

function localTableExists(localDb: Database.Database, tableName: string): boolean {
  const row = localDb
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`,
    )
    .get(tableName) as { 1: number } | undefined;
  return row !== undefined;
}

async function remoteIndexExists(
  remote: Client,
  indexName: string,
): Promise<boolean> {
  const result = await remote.execute({
    sql: `SELECT 1 FROM sqlite_master WHERE type='index' AND name = ? LIMIT 1`,
    args: [indexName],
  });
  return result.rows.length > 0;
}

function localIndexExists(localDb: Database.Database, indexName: string): boolean {
  const row = localDb
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type='index' AND name = ? LIMIT 1`,
    )
    .get(indexName) as { 1: number } | undefined;
  return row !== undefined;
}

async function sqlStatementSatisfiedOnRemote(
  remote: Client,
  statement: string,
): Promise<SchemaOpCheck> {
  const addColumn = parseAddColumnStatement(statement);
  if (addColumn) {
    if (!(await remoteTableExists(remote, addColumn.table))) {
      return "unsatisfied";
    }
    return toCheck(
      await remoteTableHasColumn(remote, addColumn.table, addColumn.column),
    );
  }

  const createIndex = parseCreateIndexStatement(statement);
  if (createIndex) {
    return toCheck(await remoteIndexExists(remote, createIndex.indexName));
  }

  const createTable = parseCreateTableStatement(statement);
  if (createTable) {
    return toCheck(await remoteTableExists(remote, createTable.table));
  }

  // DROP is satisfied when the object is gone (mirrors the drop_column op).
  const drop = parseDropStatement(statement);
  if (drop) {
    const exists =
      drop.objectType === "table"
        ? await remoteTableExists(remote, drop.name)
        : await remoteIndexExists(remote, drop.name);
    return toCheck(!exists);
  }

  // Statement shape we cannot introspect (INSERT, UPDATE, VIEW, TRIGGER, …).
  // Report unknown so callers can warn instead of failing the whole sync.
  return "unknown";
}

function sqlStatementSatisfiedOnLocal(
  localDb: Database.Database,
  statement: string,
): SchemaOpCheck {
  const addColumn = parseAddColumnStatement(statement);
  if (addColumn) {
    if (!localTableExists(localDb, addColumn.table)) {
      return "unsatisfied";
    }
    return toCheck(
      localTableHasColumn(localDb, addColumn.table, addColumn.column),
    );
  }

  const createIndex = parseCreateIndexStatement(statement);
  if (createIndex) {
    return toCheck(localIndexExists(localDb, createIndex.indexName));
  }

  const createTable = parseCreateTableStatement(statement);
  if (createTable) {
    return toCheck(localTableExists(localDb, createTable.table));
  }

  const drop = parseDropStatement(statement);
  if (drop) {
    const exists =
      drop.objectType === "table"
        ? localTableExists(localDb, drop.name)
        : localIndexExists(localDb, drop.name);
    return toCheck(!exists);
  }

  return "unknown";
}

async function schemaOpSatisfiedOnRemote(
  remote: Client,
  op: JobMigrationSchemaOp,
): Promise<SchemaOpCheck> {
  switch (op.kind) {
    case "add_column":
      if (!(await remoteTableExists(remote, op.table))) {
        return "unsatisfied";
      }
      return toCheck(await remoteTableHasColumn(remote, op.table, op.column));
    case "drop_column":
      if (!(await remoteTableExists(remote, op.table))) {
        return "satisfied";
      }
      return toCheck(
        !(await remoteTableHasColumn(remote, op.table, op.column)),
      );
    case "rename_column":
      if (!(await remoteTableExists(remote, op.table))) {
        return "unsatisfied";
      }
      return toCheck(
        (await remoteTableHasColumn(remote, op.table, op.to)) &&
          !(await remoteTableHasColumn(remote, op.table, op.from)),
      );
    case "sql":
      return sqlStatementSatisfiedOnRemote(remote, op.statement);
  }
}

function schemaOpSatisfiedOnLocal(
  localDb: Database.Database,
  op: JobMigrationSchemaOp,
): SchemaOpCheck {
  switch (op.kind) {
    case "add_column":
      if (!localTableExists(localDb, op.table)) {
        return "unsatisfied";
      }
      return toCheck(localTableHasColumn(localDb, op.table, op.column));
    case "drop_column":
      if (!localTableExists(localDb, op.table)) {
        return "satisfied";
      }
      return toCheck(!localTableHasColumn(localDb, op.table, op.column));
    case "rename_column":
      if (!localTableExists(localDb, op.table)) {
        return "unsatisfied";
      }
      return toCheck(
        localTableHasColumn(localDb, op.table, op.to) &&
          !localTableHasColumn(localDb, op.table, op.from),
      );
    case "sql":
      return sqlStatementSatisfiedOnLocal(localDb, op.statement);
  }
}

async function migrationOpsFromRoot(
  migrationRoot: string,
  migrationId: string,
): Promise<JobMigrationSchemaOp[] | null> {
  const manifest = await loadJobMigrationManifest(migrationRoot);
  const entry = manifestEntryById(manifest, migrationId);
  if (entry?.ops && entry.ops.length > 0) {
    return entry.ops;
  }

  const sql = await readMigrationSql(migrationRoot, migrationId);
  if (!sql) {
    return null;
  }

  return splitSqlStatements(sql).map((statement) => ({
    kind: "sql" as const,
    statement,
  }));
}

/**
 * Verify a migration against Turso.
 *
 * `unverifiable` lists statements we cannot introspect. Those must NOT fail the
 * migration: an unrecognized statement means "no opinion", not "broken schema".
 * Failing closed here wedges cloud sync permanently, since the verdict can
 * never change no matter how many times sync retries.
 */
export async function verifyMigrationOnRemote(
  remote: Client,
  migrationRoot: string,
  migrationId: string,
): Promise<MigrationVerification> {
  const ops = await migrationOpsFromRoot(migrationRoot, migrationId);
  if (!ops || ops.length === 0) {
    return { satisfied: false, unverifiable: [] };
  }

  const unverifiable: string[] = [];
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i];
    if (isSuperseded(ops, i)) {
      continue;
    }
    const check = await schemaOpSatisfiedOnRemote(remote, op);
    if (check === "unsatisfied") {
      return { satisfied: false, unverifiable };
    }
    if (check === "unknown") {
      unverifiable.push(describeOp(op));
    }
  }

  warnUnverifiable(migrationRoot, migrationId, "Turso", unverifiable);
  return { satisfied: true, unverifiable };
}

export async function migrationSatisfiedOnRemote(
  remote: Client,
  migrationRoot: string,
  migrationId: string,
): Promise<boolean> {
  const result = await verifyMigrationOnRemote(remote, migrationRoot, migrationId);
  return result.satisfied;
}

export async function verifyMigrationOnLocal(
  localDb: Database.Database,
  migrationRoot: string,
  migrationId: string,
): Promise<MigrationVerification> {
  const ops = await migrationOpsFromRoot(migrationRoot, migrationId);
  if (!ops || ops.length === 0) {
    return { satisfied: false, unverifiable: [] };
  }

  const unverifiable: string[] = [];
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i];
    if (isSuperseded(ops, i)) {
      continue;
    }
    const check = schemaOpSatisfiedOnLocal(localDb, op);
    if (check === "unsatisfied") {
      return { satisfied: false, unverifiable };
    }
    if (check === "unknown") {
      unverifiable.push(describeOp(op));
    }
  }

  warnUnverifiable(migrationRoot, migrationId, "local", unverifiable);
  return { satisfied: true, unverifiable };
}

export async function migrationSatisfiedOnLocal(
  localDb: Database.Database,
  migrationRoot: string,
  migrationId: string,
): Promise<boolean> {
  const result = await verifyMigrationOnLocal(localDb, migrationRoot, migrationId);
  return result.satisfied;
}

/** Copy Turso migration ledger into local schema_migrations (INSERT OR IGNORE). */
export async function hydrateLocalSchemaMigrationsFromRemote(
  remote: Client,
  localDbPath: string,
): Promise<string[]> {
  await ensureRemoteSchemaMigrationsTable(remote);
  const result = await remote.execute(
    `SELECT id, applied_at FROM ${quoteIdent(REMOTE_SCHEMA_MIGRATIONS_TABLE)} ORDER BY id`,
  );
  if (result.rows.length === 0) {
    return [];
  }

  const localDb = new Database(localDbPath);
  const hydrated: string[] = [];
  try {
    ensureSchemaMigrationsTable(localDb);
    const insert = localDb.prepare(
      "INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)",
    );
    for (const row of result.rows) {
      const id = String(row.id ?? "");
      if (id.length === 0 || shouldSkipMigrationForRemoteLedger(id)) {
        continue;
      }
      const appliedAt = String(row.applied_at ?? new Date().toISOString());
      const info = insert.run(id, appliedAt);
      if (info.changes > 0) {
        hydrated.push(id);
      }
    }
  } finally {
    localDb.close();
  }
  return hydrated;
}

/** Record migrations on Turso when schema already reflects them (legacy backfill). */
export async function reconcileRemoteMigrationLedger(
  remote: Client,
  migrationRoot: string,
): Promise<string[]> {
  const migrationIds = await listMigrationSqlFiles(migrationRoot);
  if (migrationIds.length === 0) {
    return [];
  }

  const remoteApplied = await listRemoteAppliedMigrationIds(remote);
  const backfilled: string[] = [];

  for (const migrationId of migrationIds) {
    if (shouldSkipMigrationForRemoteLedger(migrationId)) {
      continue;
    }
    if (remoteApplied.has(migrationId)) {
      continue;
    }
    if (await migrationSatisfiedOnRemote(remote, migrationRoot, migrationId)) {
      await recordRemoteMigrationApplied(remote, migrationId);
      backfilled.push(migrationId);
    }
  }

  return backfilled;
}

/** Record migrations locally when pulled schema already reflects them. */
export async function reconcileLocalMigrationLedgerFromSchema(
  localDbPath: string,
  migrationRoot: string,
): Promise<string[]> {
  const migrationIds = await listMigrationSqlFiles(migrationRoot);
  if (migrationIds.length === 0) {
    return [];
  }

  const localDb = new Database(localDbPath);
  const backfilled: string[] = [];
  try {
    ensureSchemaMigrationsTable(localDb);
    const applied = new Set(listLocalAppliedMigrationIds(localDb));
    const insert = localDb.prepare(
      "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
    );

    for (const migrationId of migrationIds) {
      if (shouldSkipMigrationForRemoteLedger(migrationId)) {
        continue;
      }
      if (applied.has(migrationId)) {
        continue;
      }
      if (await migrationSatisfiedOnLocal(localDb, migrationRoot, migrationId)) {
        insert.run(migrationId, new Date().toISOString());
        backfilled.push(migrationId);
      }
    }
  } finally {
    localDb.close();
  }

  return backfilled;
}

/**
 * Align migration ledgers after pull or before push.
 * Order: remote schema → remote ledger → local ledger (remote) → local ledger (schema).
 */
export async function alignMigrationLedgers(
  remote: Client,
  localDbPath: string,
  migrationRoot: string,
): Promise<MigrationLedgerSyncResult> {
  const remoteBackfilled = await reconcileRemoteMigrationLedger(
    remote,
    migrationRoot,
  );
  const localHydrated = await hydrateLocalSchemaMigrationsFromRemote(
    remote,
    localDbPath,
  );
  const localInferred = await reconcileLocalMigrationLedgerFromSchema(
    localDbPath,
    migrationRoot,
  );

  if (
    remoteBackfilled.length > 0 ||
    localHydrated.length > 0 ||
    localInferred.length > 0
  ) {
    console.log(
      `[MigrationLedger] Aligned ${migrationRoot}: ` +
        `remoteBackfilled=[${remoteBackfilled.join(", ")}] ` +
        `localHydrated=[${localHydrated.join(", ")}] ` +
        `localInferred=[${localInferred.join(", ")}]`,
    );
  }

  return { remoteBackfilled, localHydrated, localInferred };
}
