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
  splitSqlStatements,
} from "./migrationSqlHelpers.js";

export const REMOTE_SCHEMA_MIGRATIONS_TABLE = "_papr_schema_migrations";

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

async function listRemoteAppliedMigrationIds(
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
): Promise<boolean> {
  const addColumn = parseAddColumnStatement(statement);
  if (addColumn) {
    if (!(await remoteTableExists(remote, addColumn.table))) {
      return false;
    }
    return remoteTableHasColumn(remote, addColumn.table, addColumn.column);
  }

  const createIndex = parseCreateIndexStatement(statement);
  if (createIndex) {
    return remoteIndexExists(remote, createIndex.indexName);
  }

  const createMatch =
    /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(
      statement.trim(),
    );
  if (createMatch) {
    const table = createMatch[1] ?? createMatch[2] ?? createMatch[3];
    return table ? remoteTableExists(remote, table) : false;
  }

  return false;
}

function sqlStatementSatisfiedOnLocal(
  localDb: Database.Database,
  statement: string,
): boolean {
  const addColumn = parseAddColumnStatement(statement);
  if (addColumn) {
    if (!localTableExists(localDb, addColumn.table)) {
      return false;
    }
    return localTableHasColumn(localDb, addColumn.table, addColumn.column);
  }

  const createIndex = parseCreateIndexStatement(statement);
  if (createIndex) {
    return localIndexExists(localDb, createIndex.indexName);
  }

  const createMatch =
    /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(
      statement.trim(),
    );
  if (createMatch) {
    const table = createMatch[1] ?? createMatch[2] ?? createMatch[3];
    return table ? localTableExists(localDb, table) : false;
  }

  return false;
}

async function schemaOpSatisfiedOnRemote(
  remote: Client,
  op: JobMigrationSchemaOp,
): Promise<boolean> {
  switch (op.kind) {
    case "add_column":
      if (!(await remoteTableExists(remote, op.table))) {
        return false;
      }
      return remoteTableHasColumn(remote, op.table, op.column);
    case "drop_column":
      if (!(await remoteTableExists(remote, op.table))) {
        return true;
      }
      return !(await remoteTableHasColumn(remote, op.table, op.column));
    case "rename_column":
      if (!(await remoteTableExists(remote, op.table))) {
        return false;
      }
      return (
        (await remoteTableHasColumn(remote, op.table, op.to)) &&
        !(await remoteTableHasColumn(remote, op.table, op.from))
      );
    case "sql":
      return sqlStatementSatisfiedOnRemote(remote, op.statement);
  }
}

function schemaOpSatisfiedOnLocal(
  localDb: Database.Database,
  op: JobMigrationSchemaOp,
): boolean {
  switch (op.kind) {
    case "add_column":
      if (!localTableExists(localDb, op.table)) {
        return false;
      }
      return localTableHasColumn(localDb, op.table, op.column);
    case "drop_column":
      if (!localTableExists(localDb, op.table)) {
        return true;
      }
      return !localTableHasColumn(localDb, op.table, op.column);
    case "rename_column":
      if (!localTableExists(localDb, op.table)) {
        return false;
      }
      return (
        localTableHasColumn(localDb, op.table, op.to) &&
        !localTableHasColumn(localDb, op.table, op.from)
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

export async function migrationSatisfiedOnRemote(
  remote: Client,
  migrationRoot: string,
  migrationId: string,
): Promise<boolean> {
  const ops = await migrationOpsFromRoot(migrationRoot, migrationId);
  if (!ops || ops.length === 0) {
    return false;
  }
  for (const op of ops) {
    if (!(await schemaOpSatisfiedOnRemote(remote, op))) {
      return false;
    }
  }
  return true;
}

export async function migrationSatisfiedOnLocal(
  localDb: Database.Database,
  migrationRoot: string,
  migrationId: string,
): Promise<boolean> {
  const ops = await migrationOpsFromRoot(migrationRoot, migrationId);
  if (!ops || ops.length === 0) {
    return false;
  }
  for (const op of ops) {
    if (!schemaOpSatisfiedOnLocal(localDb, op)) {
      return false;
    }
  }
  return true;
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
