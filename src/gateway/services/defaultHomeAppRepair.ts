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
import { ensureSchemaMigrationsTable } from "./jobs/schemaMigrationsLedger.js";

export const DEFAULT_HOME_APP_ID = "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c";
export const DEFAULT_HOME_DAILY_BRIEF_JOB_ID =
  "2cafb2e9-696b-42db-98fa-5d605977123c";

export interface DefaultHomeAppRepairResult {
  prunedSources: number;
  schemaRepaired: number;
  dbPathsUpdated: number;
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
  jobExists: (jobId: string) => boolean;
  resolveJobDbPath: (jobId: string) => string;
}): Promise<DefaultHomeAppRepairResult> {
  const result: DefaultHomeAppRepairResult = {
    prunedSources: 0,
    schemaRepaired: 0,
    dbPathsUpdated: 0,
  };

  const dsPath = path.join(params.appsDir, DEFAULT_HOME_APP_ID, "data-sources.json");
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

  const kept: AppDataSource[] = [];
  for (const source of config.sources ?? []) {
    const jobId = source.jobId?.trim();
    if (jobId && !params.jobExists(jobId)) {
      result.prunedSources += 1;
      continue;
    }

    if (jobId && (!source.dbPath || source.dbPath.trim() === "")) {
      const resolved = params.resolveJobDbPath(jobId);
      if (resolved && existsSync(resolved)) {
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

  const hasDailyBrief = kept.some(
    (source) => source.jobId === DEFAULT_HOME_DAILY_BRIEF_JOB_ID,
  );
  if (!hasDailyBrief && params.jobExists(DEFAULT_HOME_DAILY_BRIEF_JOB_ID)) {
    const dbPath = params.resolveJobDbPath(DEFAULT_HOME_DAILY_BRIEF_JOB_ID);
    kept.unshift({
      id: `${DEFAULT_HOME_DAILY_BRIEF_JOB_ID}:Daily Brief Generator (${DEFAULT_HOME_DAILY_BRIEF_JOB_ID.slice(0, 8)})`,
      type: "sqlite",
      jobId: DEFAULT_HOME_DAILY_BRIEF_JOB_ID,
      alias: `Daily Brief Generator (${DEFAULT_HOME_DAILY_BRIEF_JOB_ID.slice(0, 8)})`,
      dbPath: existsSync(dbPath) ? dbPath : "",
      tables: ["briefs"],
      linkedAt: new Date().toISOString(),
    });
    result.dbPathsUpdated += 1;
  }

  const changed =
    result.prunedSources > 0 ||
    result.dbPathsUpdated > 0 ||
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
