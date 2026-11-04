/**
 * Focus database: goals, goal history, tasks, briefs and brief reviews.
 *
 * Owned by Papr Work, not by any mini-app. Every Focus service reads and writes here directly
 * instead of looping back through /api/db/* with the Home app's id, so Focus works whether or
 * not a Home app is installed and no app id can route one user's rows somewhere else.
 *
 * The file is data/databases/home-daily-briefs/data.db. The name predates native Focus; it is
 * kept so nobody's data (local file or its per-user Turso copy) has to move.
 *
 * Schema ships with Papr Work in resources/focus/db-migrations.
 */
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getPaprDataDir } from "../../core/utils/paprRoot.js";
import type { AppDataSource } from "./appDataSources.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const FOCUS_DB_SLUG = "home-daily-briefs";
export const FOCUS_DB_LABEL = "Focus";
/** Scope for pool slots, logs and token requests. Not an app id: no app owns this database. */
export const FOCUS_DB_SCOPE = "papr-focus";
const FOCUS_TABLES = ["briefs", "brief_reviews", "goals", "goal_history", "tasks", "goal_entities"];

type Row = Record<string, unknown>;

export function focusDbPath(dataDir = getPaprDataDir()): string {
  return path.join(dataDir, "databases", FOCUS_DB_SLUG, "data.db");
}

/** Bundled migrations (dist/resources/focus/db-migrations, or the asar-unpacked copy). */
export async function focusMigrationsDir(): Promise<string | null> {
  const { resolveBundledResourcesDir } = await import("../../core/utils/bundledResourcesPath.js");
  return resolveBundledResourcesDir(__dirname, "resources/focus/db-migrations");
}

async function source(): Promise<AppDataSource> {
  const dbPath = focusDbPath();
  const { getDatabaseRegistryService } = await import("./DatabaseRegistryService.js");
  const record = getDatabaseRegistryService().getByPath(dbPath);
  return {
    id: "focus",
    type: "sqlite",
    ...(record?.dbId ? { dbId: record.dbId } : {}),
    alias: "focus",
    dbPath: record?.localPath ?? dbPath,
    tables: FOCUS_TABLES,
    linkedAt: record?.createdAt ?? new Date(0).toISOString(),
  };
}

let provisioning: Promise<string[]> | null = null;
let provisionedFor: string | null = null;

/**
 * Make sure the Focus database exists, is registered (per-user isolation, so teammates never
 * share rows) and has the current schema. Safe to call often; concurrent calls share one run.
 * Returns the migrations applied by this call.
 */
export function ensureFocusDb(): Promise<string[]> {
  const dbPath = focusDbPath();
  if (provisionedFor === dbPath) return Promise.resolve([]);
  provisioning ??= (async () => {
    const { initializeDatabaseRegistry } = await import("./DatabaseRegistryService.js");
    const registry = await initializeDatabaseRegistry();
    let record = registry.getByPath(dbPath);
    if (!record) {
      const { ensureRegistryDatabase } = await import("./jobs/databaseMigrations.js");
      const { shouldDeferRegistrySqliteFileForReplica } = await import("../utils/tursoReplicaEnabled.js");
      await ensureRegistryDatabase(dbPath, { deferSqliteFile: shouldDeferRegistrySqliteFileForReplica() });
      record = await registry.register({ localPath: dbPath, label: FOCUS_DB_LABEL, isolation: "per-user" });
    } else if (record.isolation !== "per-user") {
      await registry.setIsolation(record.dbId, "per-user");
    }
    const applied = await applyFocusMigrations(record.localPath);
    if (applied.length) console.log(`[FocusDb] Applied migrations: ${applied.join(", ")}`);
    provisionedFor = dbPath;
    return applied;
  })().finally(() => {
    provisioning = null;
  });
  return provisioning;
}

/**
 * Copy bundled migration files next to the database (never overwriting one already there:
 * applied migrations are immutable) and apply what is new on the replica handle.
 */
async function applyFocusMigrations(dbPath: string): Promise<string[]> {
  const bundled = await focusMigrationsDir();
  const { resolvePersistedDatabaseLayout, applyRegistryDatabaseMigrations } = await import("./jobs/databaseMigrations.js");
  const layout = resolvePersistedDatabaseLayout(dbPath);
  if (!bundled || !layout) return [];
  const { promises: fs } = await import("fs");
  const target = path.join(layout.migrationRoot, "migrations");
  await fs.mkdir(target, { recursive: true });
  for (const file of (await fs.readdir(bundled)).filter((f) => f.endsWith(".sql"))) {
    if (existsSync(path.join(target, file))) continue;
    await fs.copyFile(path.join(bundled, file), path.join(target, file));
  }
  // Ledger-checked: already-applied files are skipped, so this is a no-op on a current database.
  const applied = await applyRegistryDatabaseMigrations(dbPath);
  if (applied.length) {
    const { getTursoReplicaSyncWorkerClient } = await import("./tursoReplica/TursoReplicaSyncWorkerClient.js");
    await getTursoReplicaSyncWorkerClient().close(dbPath).catch(() => undefined);
  }
  return applied;
}

/** Replica reported a missing table/column on the Focus DB: apply what is missing. */
export function healFocusDbSchema(dbPath: string): Promise<string[]> {
  return applyFocusMigrations(dbPath);
}

/** True when the database file exists and has the goals table. No provisioning. */
export async function focusDbReady(): Promise<boolean> {
  if (!existsSync(focusDbPath())) return false;
  try {
    const rows = await focusQuery("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'goals' LIMIT 1");
    return rows.length > 0;
  } catch {
    return false;
  }
}

export async function focusQuery(sql: string, params: unknown[] = []): Promise<Row[]> {
  const { getDbRouter } = await import("./appRuntime/DbRouter.js");
  const result = await getDbRouter().query(FOCUS_DB_SCOPE, await source(), sql, params);
  return result.rows;
}

export async function focusWrite(sql: string, params: unknown[] = []): Promise<{ changes: number; lastInsertRowid: number }> {
  const src = await source();
  const { assertValidHomeBriefWrite } = await import("./dailyBriefWriteGuard.js");
  assertValidHomeBriefWrite(FOCUS_DB_SCOPE, src, sql, params);
  const { getDbPool } = await import("./DbQueryPool.js");
  const { getDbRouter } = await import("./appRuntime/DbRouter.js");
  const { writeLinkedDbRowLocalFirst } = await import("./syncV3/localFirstDbWrite.js");
  const result = await writeLinkedDbRowLocalFirst(getDbPool(), getDbRouter(), FOCUS_DB_SCOPE, src, sql, params);
  return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
}

/** Same signature the services used for their /api/db loopback: one place to swap. */
export function focusDb(endpoint: "query" | "write", sql: string, params: unknown[] = []): Promise<Row[]> {
  return endpoint === "query" ? focusQuery(sql, params) : focusWrite(sql, params).then(() => []);
}

/** Workspace switch: the next call provisions the new workspace's database. */
export function resetFocusDbForWorkspaceSwitch(): void {
  provisionedFor = null;
}
