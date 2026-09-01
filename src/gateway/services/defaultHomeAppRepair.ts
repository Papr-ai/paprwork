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
  buildDailyBriefDataSource,
  mergeDailyBriefDataSource,
  DEFAULT_HOME_APP_ID,
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

export interface DefaultHomeAppRepairResult {
  prunedSources: number;
  schemaRepaired: number;
  dbPathsUpdated: number;
  jobIdPersisted: number;
}

function upgradeSchemaMigrationsIfReadable(dbPath: string): boolean {
  if (!existsSync(dbPath)) {
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
  workspaceRoot: string;
  jobExists: (jobId: string) => boolean;
  resolveJobDbPath: (jobId: string) => string;
  findLinkedDailyBriefJobId?: () => string | undefined;
}): Promise<DefaultHomeAppRepairResult> {
  const result: DefaultHomeAppRepairResult = {
    prunedSources: 0,
    schemaRepaired: 0,
    dbPathsUpdated: 0,
    jobIdPersisted: 0,
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

  const kept: AppDataSource[] = [];
  for (const source of config.sources ?? []) {
    const jobId = source.jobId?.trim();

    // Cloud/git sync can leave a stub row (briefs table, empty jobId/dbPath).
    // Treat it as broken — replace with a fully linked Daily Brief source.
    if (
      dailyBriefJobId &&
      source.tables?.includes("briefs") &&
      jobId !== dailyBriefJobId
    ) {
      const dbPath = params.resolveJobDbPath(dailyBriefJobId);
      kept.push(
        mergeDailyBriefDataSource(
          source,
          dailyBriefJobId,
          existsSync(dbPath) ? dbPath : "",
        ),
      );
      result.dbPathsUpdated += 1;
      continue;
    }

    if (jobId && !params.jobExists(jobId)) {
      result.prunedSources += 1;
      continue;
    }

    if (jobId) {
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
    const dbPath = params.resolveJobDbPath(dailyBriefJobId);
    kept.unshift(
      buildDailyBriefDataSource(
        dailyBriefJobId,
        existsSync(dbPath) ? dbPath : "",
      ),
    );
    result.dbPathsUpdated += 1;
  }

  const changed =
    result.prunedSources > 0 ||
    result.dbPathsUpdated > 0 ||
    result.jobIdPersisted > 0 ||
    kept.length !== (config.sources?.length ?? 0);

  if (changed) {
    await fs.writeFile(
      dsPath,
      serializeDataSourcesFile({ ...config, sources: kept }),
      "utf8",
    );
  }

  return result;
}
