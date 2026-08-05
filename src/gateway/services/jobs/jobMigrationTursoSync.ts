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

function listLocalAppliedMigrationIds(localDb: Database.Database): string[] {
  try {
    const rows = localDb
      .prepare("SELECT id FROM schema_migrations ORDER BY id")
      .all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  } catch {
    return [];
  }
}

async function applySchemaOpToRemote(
  remote: Client,
  op: JobMigrationSchemaOp,
): Promise<void> {
  switch (op.kind) {
    case "add_column":
      await dropRemoteTableSyncTriggers(remote, op.table);
      await remote.execute({
        sql:
          `ALTER TABLE ${quoteIdent(op.table)} ADD COLUMN ${quoteIdent(op.column)} ${op.type.trim() || "TEXT"}`,
        args: [],
      });
      return;
    case "drop_column":
      await dropRemoteTableSyncTriggers(remote, op.table);
      await remote.execute({
        sql:
          `ALTER TABLE ${quoteIdent(op.table)} DROP COLUMN ${quoteIdent(op.column)}`,
        args: [],
      });
      return;
    case "rename_column":
      await dropRemoteTableSyncTriggers(remote, op.table);
      await remote.execute({
        sql:
          `ALTER TABLE ${quoteIdent(op.table)} RENAME COLUMN ${quoteIdent(op.from)} TO ${quoteIdent(op.to)}`,
        args: [],
      });
      return;
    case "sql":
      await remote.execute(op.statement);
      return;
  }
}

function splitSqlStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith("--"));
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
    throw new Error(`Migration SQL missing for ${migrationId}`);
  }
  for (const statement of splitSqlStatements(sql)) {
    await remote.execute(statement);
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

  await applyDatabaseMigrations(migrationRoot, localDbPath);

  const localDb = new Database(localDbPath, { readonly: true });
  let localApplied: string[];
  try {
    localApplied = listLocalAppliedMigrationIds(localDb);
  } finally {
    localDb.close();
  }

  if (localApplied.length === 0) {
    return [];
  }

  const remoteApplied = await listRemoteAppliedMigrationIds(remote);
  const appliedNow: string[] = [];

  for (const migrationId of localApplied) {
    if (migrationId === "0001_baseline") {
      continue;
    }
    if (remoteApplied.has(migrationId)) {
      continue;
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
