/**
 * Shared SQLite schema migrations for persisted databases:
 * - Registry (app-facing): data/databases/{slug}/data.db + migrations/
 * - Job scratch: Jobs/{id}/data/data.db + migrations/ (infra only; app data uses registry)
 */

import Database from "better-sqlite3";
import {
  promises as fs,
  existsSync,
  openSync,
  readSync,
  closeSync,
} from "fs";
import path from "path";
import { quoteIdent } from "../tursoSyncBridgeCore.js";
import {
  isDuplicateColumnError,
  parseAddColumnStatement,
  splitSqlStatements,
} from "./migrationSqlHelpers.js";
import {
  loadJobMigrationManifest,
  sha256Hex,
} from "./jobMigrationManifest.js";

export type PersistedDatabaseKind = "registry" | "job";

export interface PersistedDatabaseLayout {
  kind: PersistedDatabaseKind;
  migrationRoot: string;
  dbPath: string;
}

/** Parent dir containing migrations/ and the sqlite file (registry or job layout). */
const SQLITE_MAGIC = "SQLite format 3\u0000";

/** True when path exists and begins with the SQLite file header. */
export function isValidSqliteDatabaseFile(dbPath: string): boolean {
  try {
    const fd = openSync(dbPath, "r");
    try {
      const header = Buffer.alloc(16);
      const bytesRead = readSync(fd, header, 0, 16, 0);
      if (bytesRead < 16) {
        return false;
      }
      return header.toString("utf8") === SQLITE_MAGIC;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function resolveMigrationRootFromDbPath(dbPath: string): string | null {
  const normalized = path.normalize(dbPath);
  const parentDir = path.dirname(normalized);
  const fileName = path.basename(normalized);

  if (fileName !== "data.db") {
    return null;
  }

  // Job scratch: Jobs/{id}/data/data.db → Jobs/{id}
  if (path.basename(parentDir) === "data") {
    return path.dirname(parentDir);
  }

  // Registry: data/databases/{slug}/data.db → data/databases/{slug}
  const slugDir = path.basename(parentDir);
  const databasesParent = path.basename(path.dirname(parentDir));
  if (databasesParent === "databases" && slugDir.length > 0) {
    return parentDir;
  }

  return null;
}

export function resolvePersistedDatabaseLayout(
  dbPath: string,
): PersistedDatabaseLayout | null {
  const migrationRoot = resolveMigrationRootFromDbPath(dbPath);
  if (!migrationRoot) {
    return null;
  }

  const normalizedDb = path.normalize(dbPath);
  const databasesParent = path.basename(
    path.dirname(path.dirname(normalizedDb)),
  );
  const kind: PersistedDatabaseKind =
    databasesParent === "databases" ? "registry" : "job";

  return {
    kind,
    migrationRoot: path.normalize(migrationRoot),
    dbPath: normalizedDb,
  };
}

/** Job-only layout root (legacy). Prefer resolveMigrationRootFromDbPath. */
export function jobDirFromDataDbPath(dbPath: string): string | null {
  const layout = resolvePersistedDatabaseLayout(dbPath);
  return layout?.kind === "job" ? layout.migrationRoot : null;
}

export function applySqlitePerformancePragmas(
  db: Database.Database,
  cacheSizeKb = 5000,
): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma(`cache_size = -${cacheSizeKb}`);
  db.pragma("mmap_size = 15000000");
  db.pragma("temp_store = MEMORY");
}

export function localTableHasColumn(
  db: Database.Database,
  tableName: string,
  columnName: string,
): boolean {
  const rows = db
    .prepare(`PRAGMA table_info(${quoteIdent(tableName)})`)
    .all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

function executeLocalSqlIdempotent(
  db: Database.Database,
  statement: string,
): void {
  const addColumn = parseAddColumnStatement(statement);
  if (addColumn) {
    if (localTableHasColumn(db, addColumn.table, addColumn.column)) {
      return;
    }
  }

  try {
    db.exec(`${statement};`);
  } catch (error) {
    if (isDuplicateColumnError(error)) {
      return;
    }
    throw error;
  }
}

import {
  ensureSchemaMigrationsTable,
  listAppliedMigrationIdsReadOnly,
} from "./schemaMigrationsLedger.js";

export {
  ensureSchemaMigrationsTable,
  listAppliedMigrationIds,
  listAppliedMigrationIdsReadOnly,
} from "./schemaMigrationsLedger.js";

/**
 * Ensure registry database file, migrations folder, and schema_migrations table.
 * Called from create_database and before applying registry migrations.
 */
export async function ensureRegistryDatabase(dbPath: string): Promise<string> {
  const layout = resolvePersistedDatabaseLayout(dbPath);
  if (!layout || layout.kind !== "registry") {
    throw new Error(`Not a registry database path: ${dbPath}`);
  }

  await fs.mkdir(path.join(layout.migrationRoot, "migrations"), {
    recursive: true,
  });
  await fs.mkdir(path.dirname(layout.dbPath), { recursive: true });

  let db: Database.Database | null = null;
  try {
    db = new Database(layout.dbPath);
    applySqlitePerformancePragmas(db);
    ensureSchemaMigrationsTable(db);
  } catch {
    await fs.writeFile(layout.dbPath, "", { flag: "a" });
  } finally {
    db?.close();
  }

  const baselineMigration = path.join(
    layout.migrationRoot,
    "migrations",
    "0001_baseline.sql",
  );
  try {
    await fs.access(baselineMigration);
  } catch {
    await fs.writeFile(baselineMigration, "-- registry database baseline\n");
  }

  return layout.dbPath;
}

/** Apply pending migrations/*.sql under migrationRoot against dbPath. */
export async function applyDatabaseMigrations(
  migrationRoot: string,
  dbPath: string,
): Promise<string[]> {
  const migrationsDir = path.join(migrationRoot, "migrations");
  await fs.mkdir(migrationsDir, { recursive: true });
  await fs.mkdir(path.dirname(dbPath), { recursive: true });

  if (existsSync(dbPath) && !isValidSqliteDatabaseFile(dbPath)) {
    throw new Error(
      `Database file is corrupt or empty (${dbPath}). Restore from the newest .sync-backup file in the same folder, or ask the agent to re-link the database.`,
    );
  }

  const files = (await fs.readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const migrationSqlByFile = new Map<string, string>();
  for (const fileName of files) {
    migrationSqlByFile.set(
      fileName,
      await fs.readFile(path.join(migrationsDir, fileName), "utf8"),
    );
  }

  const manifest = await loadJobMigrationManifest(migrationRoot);

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath);
    applySqlitePerformancePragmas(db);
    ensureSchemaMigrationsTable(db);

    const appliedIds = new Set(listAppliedMigrationIdsReadOnly(db));
    const appliedNow: string[] = [];

    for (const fileName of files) {
      if (appliedIds.has(fileName)) {
        continue;
      }
      const sql = migrationSqlByFile.get(fileName);
      if (!sql) {
        continue;
      }
      const manifestEntry = manifest?.migrations.find((e) => e.id === fileName);
      if (
        manifestEntry?.checksum &&
        manifestEntry.checksum !== sha256Hex(sql)
      ) {
        throw new Error(
          `Migration checksum mismatch for ${fileName}: manifest does not match SQL file`,
        );
      }
      for (const statement of splitSqlStatements(sql)) {
        executeLocalSqlIdempotent(db, statement);
      }
      db.prepare(
        "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
      ).run(fileName, new Date().toISOString());
      appliedNow.push(fileName);
    }

    return appliedNow;
  } finally {
    db?.close();
  }
}

/** Apply migrations for a registry db path (no-op when layout unrecognized). */
export async function applyRegistryDatabaseMigrations(
  dbPath: string,
): Promise<string[]> {
  const layout = resolvePersistedDatabaseLayout(dbPath);
  if (!layout || layout.kind !== "registry") {
    return [];
  }
  await ensureRegistryDatabase(layout.dbPath);
  return applyDatabaseMigrations(layout.migrationRoot, layout.dbPath);
}
