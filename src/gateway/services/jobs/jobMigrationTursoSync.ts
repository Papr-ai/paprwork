/**
 * Replay SQL migrations onto Turso — cloud gets schema from manifest/SQL, not job runs.
 *
 * Local: applyDatabaseMigrations() on registry DBs + job scratch DBs.
 * Cloud: pending migrations replayed during Turso push (Upload now / debounced sync).
 */

import type { Client } from "@libsql/client";
import Database from "better-sqlite3";
import { promises as fs } from "fs";
import path from "path";
import type { JobMigrationSchemaOp } from "../../../core/types/jobMigrations.js";
import { quoteIdent } from "../tursoSyncBridgeCore.js";
import { dropRemoteTableSyncTriggers } from "../tursoSyncLog.js";
import { applyDatabaseMigrations } from "./databaseMigrations.js";
import {
  loadJobMigrationManifest,
  manifestEntryById,
  readMigrationSql,
} from "./jobMigrationManifest.js";
import {
  alignMigrationLedgers,
  migrationSatisfiedOnRemote,
  remoteTableExists,
} from "./jobMigrationLedgerSync.js";
import {
  isDuplicateColumnError,
  parseAddColumnStatement,
  splitSqlStatements,
} from "./migrationSqlHelpers.js";
import { shouldSkipMigrationForRemoteLedger } from "./migrationLedgerPolicy.js";
import { listAppliedMigrationIdsReadOnly } from "./schemaMigrationsLedger.js";

export const REMOTE_SCHEMA_MIGRATIONS_TABLE = "_papr_schema_migrations";

export { resolveMigrationRootFromDbPath, jobDirFromDataDbPath } from "./databaseMigrations.js";

export async function ensureRemoteSchemaMigrationsTable(
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

async function listRemoteAppliedMigrationIds(remote: Client): Promise<Set<string>> {
  await ensureRemoteSchemaMigrationsTable(remote);
  const result = await remote.execute(
    `SELECT id FROM ${quoteIdent(REMOTE_SCHEMA_MIGRATIONS_TABLE)}`,
  );
  return new Set(
    result.rows.map((row) => String(row.id ?? "")).filter((id) => id.length > 0),
  );
}

async function remoteTableHasColumn(
  remote: Client,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const result = await remote.execute(`PRAGMA table_info(${quoteIdent(tableName)})`);
  return result.rows.some((row) => String(row.name ?? "") === columnName);
}

async function executeRemoteSqlIdempotent(
  remote: Client,
  statement: string,
): Promise<void> {
  const addColumn = parseAddColumnStatement(statement);
  if (addColumn) {
    if (!(await remoteTableExists(remote, addColumn.table))) {
      return;
    }
    if (await remoteTableHasColumn(remote, addColumn.table, addColumn.column)) {
      return;
    }
  }

  try {
    await remote.execute(statement);
  } catch (error) {
    if (isDuplicateColumnError(error)) {
      return;
    }
    throw error;
  }
}

async function applySchemaOpToRemote(
  remote: Client,
  op: JobMigrationSchemaOp,
): Promise<void> {
  switch (op.kind) {
    case "add_column":
      if (!(await remoteTableExists(remote, op.table))) {
        return;
      }
      if (await remoteTableHasColumn(remote, op.table, op.column)) {
        return;
      }
      await dropRemoteTableSyncTriggers(remote, op.table);
      try {
        await remote.execute({
          sql:
            `ALTER TABLE ${quoteIdent(op.table)} ADD COLUMN ${quoteIdent(op.column)} ${op.type.trim() || "TEXT"}`,
          args: [],
        });
      } catch (error) {
        if (!isDuplicateColumnError(error)) {
          throw error;
        }
      }
      return;
    case "drop_column":
      if (!(await remoteTableExists(remote, op.table))) {
        return;
      }
      await dropRemoteTableSyncTriggers(remote, op.table);
      await remote.execute({
        sql:
          `ALTER TABLE ${quoteIdent(op.table)} DROP COLUMN ${quoteIdent(op.column)}`,
        args: [],
      });
      return;
    case "rename_column":
      if (!(await remoteTableExists(remote, op.table))) {
        return;
      }
      await dropRemoteTableSyncTriggers(remote, op.table);
      await remote.execute({
        sql:
          `ALTER TABLE ${quoteIdent(op.table)} RENAME COLUMN ${quoteIdent(op.from)} TO ${quoteIdent(op.to)}`,
        args: [],
      });
      return;
    case "sql":
      await executeRemoteSqlIdempotent(remote, op.statement);
      return;
  }
}

async function applyMigrationToRemote(
  remote: Client,
  migrationRoot: string,
  migrationId: string,
): Promise<void> {
  const manifest = await loadJobMigrationManifest(migrationRoot);
  const entry = manifestEntryById(manifest, migrationId);

  if (entry?.ops && entry.ops.length > 0) {
    for (const op of entry.ops) {
      await applySchemaOpToRemote(remote, op);
    }
    return;
  }

  const sql = await readMigrationSql(migrationRoot, migrationId);
  if (!sql) {
    if (await migrationSatisfiedOnRemote(remote, migrationRoot, migrationId)) {
      console.warn(
        `[MigrationTurso] ${migrationId} SQL file missing but remote schema already satisfied — skipping replay`,
      );
      return;
    }
    throw new Error(`Migration SQL missing for ${migrationId}`);
  }
  for (const statement of splitSqlStatements(sql)) {
    await executeRemoteSqlIdempotent(remote, statement);
  }
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

/**
 * Apply pending local migration files, then replay to Turso anything recorded in schema_migrations.
 */
export async function applyPendingDatabaseMigrationsToTurso(
  remote: Client,
  localDbPath: string,
  migrationRoot: string,
): Promise<string[]> {
  const migrationsDir = path.join(migrationRoot, "migrations");
  try {
    await fs.access(migrationsDir);
  } catch {
    return [];
  }

  await alignMigrationLedgers(remote, localDbPath, migrationRoot);
  await applyDatabaseMigrations(migrationRoot, localDbPath);

  const localDb = new Database(localDbPath, { readonly: true });
  let localApplied: string[];
  try {
    localApplied = listAppliedMigrationIdsReadOnly(localDb);
  } finally {
    localDb.close();
  }

  if (localApplied.length === 0) {
    return [];
  }

  const remoteApplied = await listRemoteAppliedMigrationIds(remote);
  const appliedNow: string[] = [];

  for (const migrationId of localApplied) {
    if (shouldSkipMigrationForRemoteLedger(migrationId)) {
      continue;
    }
    if (remoteApplied.has(migrationId)) {
      const satisfied = await migrationSatisfiedOnRemote(
        remote,
        migrationRoot,
        migrationId,
      );
      if (satisfied) {
        continue;
      }
      console.warn(
        `[MigrationTurso] Remote ledger lists ${migrationId} but schema is incomplete — re-applying`,
      );
    }
    await applyMigrationToRemote(remote, migrationRoot, migrationId);
    await recordRemoteMigrationApplied(remote, migrationId);
    appliedNow.push(migrationId);
  }

  return appliedNow;
}

/** @deprecated Use applyPendingDatabaseMigrationsToTurso */
export async function applyPendingJobMigrationsToTurso(
  remote: Client,
  localDbPath: string,
  migrationRoot: string,
): Promise<string[]> {
  return applyPendingDatabaseMigrationsToTurso(
    remote,
    localDbPath,
    migrationRoot,
  );
}
