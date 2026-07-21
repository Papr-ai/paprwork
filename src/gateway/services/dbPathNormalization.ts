/**
 * Detect and normalize stray SQLite files outside canonical APP_DB / JOB_DB paths.
 *
 * Never runs automatically — callers must invoke normalizeAppDatabases explicitly
 * (agent tool or POST /api/apps/:appId/normalize-databases). Default is dry-run.
 *
 * Canonical job DB: {jobDir}/data/data.db
 * Mini-apps must not store databases in the app folder — use linked job primary only.
 */

import { promises as fs } from "fs";
import { existsSync } from "fs";
import path from "path";
import {
  dbHasOnlyBaselineTables,
  type AppDataSourcesFile,
} from "./appDataSources.js";
import { getAppService } from "./AppService.js";
import { getJobsService } from "./JobsService.js";
import { jobBelongsToApp } from "./jobs/appIds.js";

export const CANONICAL_JOB_DB_RELATIVE = path.join("data", "data.db");

/** Known stray filenames agents create by mistake. */
export const STRAY_DB_BASENAMES = new Set([
  "audit.db",
  "data.db",
  "database.sqlite",
  "app.db",
  "scratch.db",
]);

export type StrayDbClassification = "empty" | "baseline_only" | "has_user_data";

export type StrayDbLocation = "app_dir" | "job_root" | "job_noncanonical";

export interface StrayDbFile {
  path: string;
  sizeBytes: number;
  location: StrayDbLocation;
  jobId?: string;
  classification: StrayDbClassification;
  suggestedAction: "delete" | "warn" | "migrate_to_primary";
}

export interface NormalizeAction {
  path: string;
  action: "delete" | "skip" | "migrate";
  success: boolean;
  message: string;
}

export interface NormalizeReport {
  appId: string;
  primaryDbPath: string | null;
  dryRun: boolean;
  strayFiles: StrayDbFile[];
  actions: NormalizeAction[];
}

function classifyDbFile(dbPath: string, sizeBytes: number): StrayDbClassification {
  if (sizeBytes === 0) return "empty";
  if (dbHasOnlyBaselineTables(dbPath)) return "baseline_only";
  return "has_user_data";
}

function isStrayBasename(name: string): boolean {
  if (STRAY_DB_BASENAMES.has(name)) return true;
  return name.endsWith(".db") || name.endsWith(".sqlite");
}

function normalizePath(p: string): string {
  return path.resolve(p);
}

function pathsEqual(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

function suggestAction(
  classification: StrayDbClassification,
  location: StrayDbLocation,
): StrayDbFile["suggestedAction"] {
  if (classification === "empty" || classification === "baseline_only") {
    return "delete";
  }
  if (location === "app_dir") {
    return "warn";
  }
  return "migrate_to_primary";
}

async function statSafe(filePath: string): Promise<{ sizeBytes: number } | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    return { sizeBytes: stat.size };
  } catch {
    return null;
  }
}

async function collectAppDirStrays(
  appDir: string,
  primaryDbPath: string | null,
): Promise<StrayDbFile[]> {
  const strays: StrayDbFile[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(appDir);
  } catch {
    return strays;
  }

  for (const name of entries) {
    if (name === "db.ts" || name.startsWith(".")) continue;
    if (!isStrayBasename(name)) continue;

    const fullPath = path.join(appDir, name);
    if (primaryDbPath && pathsEqual(fullPath, primaryDbPath)) continue;

    const stat = await statSafe(fullPath);
    if (!stat) continue;

    const classification = classifyDbFile(fullPath, stat.sizeBytes);
    strays.push({
      path: fullPath,
      sizeBytes: stat.sizeBytes,
      location: "app_dir",
      classification,
      suggestedAction: suggestAction(classification, "app_dir"),
    });
  }

  return strays;
}

async function collectJobDirStrays(
  jobId: string,
  jobDir: string,
  primaryDbPath: string | null,
): Promise<StrayDbFile[]> {
  const strays: StrayDbFile[] = [];
  const canonical = path.join(jobDir, CANONICAL_JOB_DB_RELATIVE);

  const candidates: Array<{ filePath: string; location: StrayDbLocation }> = [
    { filePath: path.join(jobDir, "audit.db"), location: "job_root" },
    { filePath: path.join(jobDir, "data.db"), location: "job_root" },
    { filePath: path.join(jobDir, "database.sqlite"), location: "job_root" },
    { filePath: path.join(jobDir, "data", "audit.db"), location: "job_noncanonical" },
  ];

  for (const { filePath, location } of candidates) {
    if (pathsEqual(filePath, canonical)) continue;
    if (primaryDbPath && pathsEqual(filePath, primaryDbPath)) continue;

    const stat = await statSafe(filePath);
    if (!stat) continue;
    if (stat.sizeBytes === 0 && location === "job_root") {
      // still report empty root stubs
    }

    const classification = classifyDbFile(filePath, stat.sizeBytes);
    strays.push({
      path: filePath,
      sizeBytes: stat.sizeBytes,
      location,
      jobId,
      classification,
      suggestedAction: suggestAction(classification, location),
    });
  }

  return strays;
}

export async function findStrayDatabaseFiles(
  appId: string,
  config: AppDataSourcesFile,
  primaryDbPath: string | null,
): Promise<StrayDbFile[]> {
  const appService = getAppService();
  const jobsService = getJobsService();
  const appDir = path.join(appService.getAppsRootPath(), appId);

  const strays: StrayDbFile[] = [];
  const seen = new Set<string>();

  const add = (item: StrayDbFile): void => {
    const key = normalizePath(item.path);
    if (seen.has(key)) return;
    seen.add(key);
    strays.push(item);
  };

  for (const item of await collectAppDirStrays(appDir, primaryDbPath)) {
    add(item);
  }

  const linkedJobIds = new Set(config.sources.map((s) => s.jobId));
  for (const job of await jobsService.listJobs()) {
    if (!jobBelongsToApp(job.appIds, appId) && !linkedJobIds.has(job.id)) {
      continue;
    }
    const jobDir = await jobsService.getJobPath(job.id);
    if (!jobDir) continue;
    for (const item of await collectJobDirStrays(job.id, jobDir, primaryDbPath)) {
      add(item);
    }
  }

  return strays;
}

async function primaryNeedsData(primaryDbPath: string | null): Promise<boolean> {
  if (!primaryDbPath || !existsSync(primaryDbPath)) return true;
  const stat = await statSafe(primaryDbPath);
  if (!stat || stat.sizeBytes === 0) return true;
  return dbHasOnlyBaselineTables(primaryDbPath);
}

export async function normalizeAppDatabases(
  appId: string,
  options: { dryRun?: boolean } = {},
): Promise<NormalizeReport> {
  const dryRun = options.dryRun !== false;
  const appService = getAppService();
  await appService.initialize();
  const jobsService = getJobsService();
  await jobsService.initialize();

  const primary = await appService.getPrimaryDataSource(appId);
  const primaryDbPath = primary?.dbPath ?? null;
  const config = await appService.getDataSourcesConfig(appId);
  const strayFiles = await findStrayDatabaseFiles(appId, config, primaryDbPath);
  const actions: NormalizeAction[] = [];
  const primaryEmpty = await primaryNeedsData(primaryDbPath);

  for (const stray of strayFiles) {
    if (stray.suggestedAction === "delete") {
      if (dryRun) {
        actions.push({
          path: stray.path,
          action: "delete",
          success: true,
          message: `Would delete ${stray.classification} stray file`,
        });
        continue;
      }
      try {
        await fs.unlink(stray.path);
        actions.push({
          path: stray.path,
          action: "delete",
          success: true,
          message: `Deleted ${stray.classification} stray file`,
        });
      } catch (err) {
        actions.push({
          path: stray.path,
          action: "delete",
          success: false,
          message: (err as Error).message,
        });
      }
      continue;
    }

    if (
      stray.suggestedAction === "migrate_to_primary" &&
      primaryDbPath &&
      primaryEmpty &&
      stray.location !== "app_dir"
    ) {
      if (dryRun) {
        actions.push({
          path: stray.path,
          action: "migrate",
          success: true,
          message: `Would copy data to primary ${primaryDbPath}`,
        });
        continue;
      }
      try {
        await fs.mkdir(path.dirname(primaryDbPath), { recursive: true });
        if (existsSync(primaryDbPath)) {
          const backup = `${primaryDbPath}.bak.${Date.now()}`;
          await fs.copyFile(primaryDbPath, backup);
        }
        await fs.copyFile(stray.path, primaryDbPath);
        actions.push({
          path: stray.path,
          action: "migrate",
          success: true,
          message: `Copied to primary ${primaryDbPath}`,
        });
      } catch (err) {
        actions.push({
          path: stray.path,
          action: "migrate",
          success: false,
          message: (err as Error).message,
        });
      }
      continue;
    }

    actions.push({
      path: stray.path,
      action: "skip",
      success: true,
      message:
        stray.location === "app_dir"
          ? "App folder must not hold databases — move writes to $APP_DB manually"
          : "Primary already has data — review before deleting stray copy",
    });
  }

  return {
    appId,
    primaryDbPath,
    dryRun,
    strayFiles,
    actions,
  };
}
