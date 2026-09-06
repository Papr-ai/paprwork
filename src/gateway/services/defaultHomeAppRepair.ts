/**
 * Startup repair for the bundled Home app — runs for every user on gateway init.
 * Prunes broken data-source links and upgrades legacy schema_migrations layouts.
 */

import { existsSync } from "fs";
import { promises as fs } from "fs";
import Database from "better-sqlite3";
import path from "path";
import {
  parseDataSourcesFile,
  serializeDataSourcesFile,
  type AppDataSource,
} from "./appDataSources.js";
import {
  dailyBriefDataSourceNeedsUpdate,
  mergeDailyBriefDataSource,
  DEFAULT_HOME_APP_ID,
  DEFAULT_HOME_DB_MIGRATIONS_DIR,
  isHomeDailyBriefRegistryDbPath,
  readHomeDailyBriefJobIdFromAppDir,
  resolveHomeDailyBriefJobId,
  shouldRewriteDailyBriefDbPath,
  writeHomeDailyBriefJobIdToAppDir,
} from "./defaultHomeBundle.js";
import { ensureSchemaMigrationsTable } from "./jobs/schemaMigrationsLedger.js";

export {
  DEFAULT_HOME_APP_ID,
  DEFAULT_HOME_DAILY_BRIEF_JOB_ID,
  LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID,
} from "./defaultHomeBundle.js";

export interface DailyBriefReadTarget {
  dbPath: string;
  dbId?: string;
}

export interface DefaultHomeAppRepairResult {
  prunedSources: number;
  schemaRepaired: number;
  dbPathsUpdated: number;
  jobIdPersisted: number;
  registryUpgraded: number;
}

/**
 * Copy bundled Home app db-migrations into the registry migrations/ folder.
 * Only adds files that are missing — never overwrites applied migrations.
 */
export async function syncBundledHomeMigrationsToRegistry(
  registryDbPath: string,
  options?: { appsDir?: string; bundledMigrationsDir?: string },
): Promise<string[]> {
  if (!isHomeDailyBriefRegistryDbPath(registryDbPath)) {
    return [];
  }
  const { resolvePersistedDatabaseLayout } = await import(
    "./jobs/databaseMigrations.js"
  );
  const layout = resolvePersistedDatabaseLayout(registryDbPath);
  if (!layout) {
    return [];
  }

  let bundledDir = options?.bundledMigrationsDir?.trim();
  if (!bundledDir) {
    const { getPaprAppsRoot } = await import("../../core/utils/paprRoot.js");
    const appsDir = options?.appsDir ?? getPaprAppsRoot();
    bundledDir = path.join(
      appsDir,
      DEFAULT_HOME_APP_ID,
      DEFAULT_HOME_DB_MIGRATIONS_DIR,
    );
  }
  const targetDir = path.join(layout.migrationRoot, "migrations");
  await fs.mkdir(targetDir, { recursive: true });

  const copied: string[] = [];
  let bundledFiles: string[];
  try {
    bundledFiles = await fs.readdir(bundledDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [];
    }
    throw err;
  }

  for (const file of bundledFiles) {
    if (!file.endsWith(".sql")) {
      continue;
    }
    const target = path.join(targetDir, file);
    if (existsSync(target)) {
      continue;
    }
    await fs.copyFile(path.join(bundledDir, file), target);
    copied.push(file);
  }

  return copied;
}

/** Apply registry migrations on the Turso replica handle and refresh the worker. */
export async function ensureHomeDailyBriefRegistrySchema(
  dbPath: string,
  options?: { appsDir?: string },
): Promise<string[]> {
  if (!isHomeDailyBriefRegistryDbPath(dbPath)) {
    return [];
  }

  const { getPaprAppsRoot } = await import("../../core/utils/paprRoot.js");
  const copied = await syncBundledHomeMigrationsToRegistry(dbPath, {
    appsDir: options?.appsDir ?? getPaprAppsRoot(),
  });
  if (copied.length > 0) {
    console.log(
      `[DefaultHomeAppRepair] Copied bundled Home migrations: ${copied.join(", ")}`,
    );
  }

  const { applyRegistryDatabaseMigrations } = await import(
    "./jobs/databaseMigrations.js"
  );
  const applied = await applyRegistryDatabaseMigrations(dbPath);

  const { getDatabaseRegistryService } = await import(
    "./DatabaseRegistryService.js"
  );
  const record = getDatabaseRegistryService().getByPath(dbPath);
  if (record) {
    const { migrationSatisfiedOnReplica } = await import(
      "./tursoReplica/tursoReplicaMigrationVerify.js"
    );
    const { applyRegistryMigrationOnReplicaOnly } = await import(
      "./tursoReplica/tursoReplicaMigrationDualApply.js"
    );
    const { resolvePersistedDatabaseLayout } = await import(
      "./jobs/databaseMigrations.js"
    );
    const layout = resolvePersistedDatabaseLayout(dbPath);
    const source: AppDataSource = {
      id: record.dbId,
      type: "sqlite",
      dbId: record.dbId,
      alias: record.label ?? record.dbId,
      dbPath: record.localPath,
      tables: [],
      linkedAt: record.createdAt,
    };
    if (layout) {
      const migrationsDir = path.join(layout.migrationRoot, "migrations");
      let migrationFiles: string[] = [];
      try {
        migrationFiles = (await fs.readdir(migrationsDir))
          .filter((name) => name.endsWith(".sql"))
          .sort();
      } catch {
        migrationFiles = [];
      }

      for (const file of migrationFiles) {
        const bareId = file.replace(/\.sql$/, "");
        const satisfied = await migrationSatisfiedOnReplica(
          source,
          layout.migrationRoot,
          bareId,
        ).catch(() => false);
        if (satisfied) {
          continue;
        }
        console.warn(
          `[DefaultHomeAppRepair] Migration ${file} not satisfied on replica — applying`,
        );
        await applyRegistryMigrationOnReplicaOnly(
          source,
          layout.migrationRoot,
          file,
        );
        applied.push(file);
      }
    }
  }

  const { getTursoReplicaSyncWorkerClient } = await import(
    "./tursoReplica/TursoReplicaSyncWorkerClient.js"
  );
  await getTursoReplicaSyncWorkerClient().close(dbPath).catch(() => undefined);

  return applied;
}

function mergeBriefSource(
  existing: AppDataSource | undefined,
  jobId: string,
  readTarget: DailyBriefReadTarget | undefined,
): AppDataSource {
  const dbPath = readTarget?.dbPath?.trim() ?? "";
  return mergeDailyBriefDataSource(existing, jobId, dbPath, readTarget?.dbId);
}

function upgradeSchemaMigrationsIfReadable(dbPath: string): boolean {
  if (!existsSync(dbPath) || isHomeDailyBriefRegistryDbPath(dbPath)) {
    return false;
  }
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath);
    ensureSchemaMigrationsTable(db);
    return true;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

export async function repairDefaultHomeAppLinkedSources(params: {
  appsDir: string;
  workspaceRoot?: string;
  jobExists: (jobId: string) => boolean;
  resolveJobDbPath: (jobId: string) => string;
  findLinkedDailyBriefJobId?: () => string | undefined;
  /** Prefer the Home briefs registry DB when provisioned (not the job scratch DB). */
  resolveBriefReadTarget?: (
    jobId: string,
  ) => Promise<DailyBriefReadTarget | undefined>;
}): Promise<DefaultHomeAppRepairResult> {
  const result: DefaultHomeAppRepairResult = {
    prunedSources: 0,
    schemaRepaired: 0,
    dbPathsUpdated: 0,
    jobIdPersisted: 0,
    registryUpgraded: 0,
  };

  const appDir = path.join(params.appsDir, DEFAULT_HOME_APP_ID);
  const dsPath = path.join(appDir, "data-sources.json");
  let raw: string;
  try {
    raw = await fs.readFile(dsPath, "utf-8");
  } catch {
    return result;
  }

  let config;
  try {
    config = parseDataSourcesFile(raw);
  } catch {
    return result;
  }

  const jobIdFromFile = await readHomeDailyBriefJobIdFromAppDir(appDir);
  const dailyBriefJobId = resolveHomeDailyBriefJobId({
    appDir,
    jobIdFromFile,
    jobExists: params.jobExists,
    findLinkedJobId: params.findLinkedDailyBriefJobId,
  });

  if (dailyBriefJobId && jobIdFromFile !== dailyBriefJobId) {
    await writeHomeDailyBriefJobIdToAppDir(appDir, dailyBriefJobId);
    result.jobIdPersisted += 1;
  }

  let readTarget: DailyBriefReadTarget | undefined;
  if (dailyBriefJobId && params.resolveBriefReadTarget) {
    readTarget = await params.resolveBriefReadTarget(dailyBriefJobId);
  } else if (dailyBriefJobId) {
    const jobDbPath = params.resolveJobDbPath(dailyBriefJobId);
    readTarget = {
      dbPath: existsSync(jobDbPath) ? jobDbPath : "",
    };
  }

  const kept: AppDataSource[] = [];
  for (const source of config.sources ?? []) {
    const jobId = source.jobId?.trim();
    const isBriefSource = source.tables?.includes("briefs");

    // Cloud/git sync can leave a stub row (briefs table, empty jobId/dbPath).
    // Treat it as broken — replace with a fully linked Daily Brief source.
    if (dailyBriefJobId && isBriefSource && jobId !== dailyBriefJobId) {
      const merged = mergeBriefSource(source, dailyBriefJobId, readTarget);
      if (dailyBriefDataSourceNeedsUpdate(source, merged)) {
        result.dbPathsUpdated += 1;
      }
      if (
        readTarget?.dbPath &&
        isHomeDailyBriefRegistryDbPath(readTarget.dbPath) &&
        !isHomeDailyBriefRegistryDbPath(source.dbPath ?? "")
      ) {
        result.registryUpgraded += 1;
      }
      kept.push(merged);
      continue;
    }

    if (jobId && !params.jobExists(jobId)) {
      result.prunedSources += 1;
      continue;
    }

    if (dailyBriefJobId && isBriefSource && jobId === dailyBriefJobId) {
      const merged = mergeBriefSource(source, dailyBriefJobId, readTarget);
      if (dailyBriefDataSourceNeedsUpdate(source, merged)) {
        result.dbPathsUpdated += 1;
      }
      if (
        readTarget?.dbPath &&
        isHomeDailyBriefRegistryDbPath(readTarget.dbPath) &&
        !isHomeDailyBriefRegistryDbPath(source.dbPath ?? "")
      ) {
        result.registryUpgraded += 1;
      }
      const dbPath = merged.dbPath?.trim();
      if (dbPath && upgradeSchemaMigrationsIfReadable(dbPath)) {
        result.schemaRepaired += 1;
      }
      kept.push(merged);
      continue;
    }

    if (jobId && params.workspaceRoot) {
      const resolved = params.resolveJobDbPath(jobId);
      if (
        shouldRewriteDailyBriefDbPath({
          storedDbPath: source.dbPath,
          resolvedDbPath: resolved,
          workspaceRoot: params.workspaceRoot,
        })
      ) {
        source.dbPath = resolved;
        result.dbPathsUpdated += 1;
      }
    }

    const dbPath = source.dbPath?.trim();
    if (dbPath && upgradeSchemaMigrationsIfReadable(dbPath)) {
      result.schemaRepaired += 1;
    }

    kept.push(source);
  }

  const hasDailyBrief =
    dailyBriefJobId !== undefined &&
    kept.some(
      (source) =>
        source.jobId === dailyBriefJobId &&
        source.tables?.includes("briefs"),
    );

  if (!hasDailyBrief && dailyBriefJobId) {
    kept.unshift(mergeBriefSource(undefined, dailyBriefJobId, readTarget));
    result.dbPathsUpdated += 1;
    if (
      readTarget?.dbPath &&
      isHomeDailyBriefRegistryDbPath(readTarget.dbPath)
    ) {
      result.registryUpgraded += 1;
    }
  }

  const changed =
    result.prunedSources > 0 ||
    result.dbPathsUpdated > 0 ||
    result.jobIdPersisted > 0 ||
    result.registryUpgraded > 0 ||
    kept.length !== (config.sources?.length ?? 0);

  if (changed) {
    await fs.writeFile(
      dsPath,
      serializeDataSourcesFile({ ...config, sources: kept }),
      "utf8",
    );
  }

  const registryDbPath = readTarget?.dbPath?.trim();
  if (registryDbPath && isHomeDailyBriefRegistryDbPath(registryDbPath)) {
    const applied = await ensureHomeDailyBriefRegistrySchema(
      registryDbPath,
      { appsDir: params.appsDir },
    ).catch((err) => {
      console.warn(
        "[DefaultHomeAppRepair] Final registry schema repair failed:",
        err,
      );
      return [] as string[];
    });
    if (applied.length > 0) {
      result.schemaRepaired += 1;
    }
  }

  return result;
}
