/**
 * Cheap checks for bundled Home data-sources — no replica migrations.
 */

import { promises as fs } from "fs";
import path from "path";
import {
  dailyBriefDataSourceNeedsUpdate,
  DEFAULT_HOME_APP_ID,
  isHomeDailyBriefRegistryDbPath,
  mergeDailyBriefDataSource,
  readHomeDailyBriefJobIdFromAppDir,
  resolveHomeDailyBriefJobId,
} from "./defaultHomeBundle.js";
import type { DailyBriefReadTarget } from "./defaultHomeAppRepair.js";
import { parseDataSourcesFile } from "./appDataSources.js";

export async function homeLinkedSourcesInvariantsOk(params: {
  appsDir: string;
  jobExists: (jobId: string) => boolean;
  resolveBriefReadTarget?: (
    jobId: string,
  ) => Promise<DailyBriefReadTarget | undefined>;
}): Promise<boolean> {
  const appDir = path.join(params.appsDir, DEFAULT_HOME_APP_ID);
  const dsPath = path.join(appDir, "data-sources.json");
  let raw: string;
  try {
    raw = await fs.readFile(dsPath, "utf-8");
  } catch {
    return false;
  }

  let config;
  try {
    config = parseDataSourcesFile(raw);
  } catch {
    return false;
  }

  const jobIdFromFile = await readHomeDailyBriefJobIdFromAppDir(appDir);
  const dailyBriefJobId = resolveHomeDailyBriefJobId({
    appDir,
    jobIdFromFile,
    jobExists: params.jobExists,
  });
  if (!dailyBriefJobId) {
    return false;
  }

  if (jobIdFromFile !== dailyBriefJobId) {
    return false;
  }

  let readTarget: DailyBriefReadTarget | undefined;
  if (params.resolveBriefReadTarget) {
    readTarget = await params.resolveBriefReadTarget(dailyBriefJobId);
  }

  const sources = config.sources ?? [];
  for (const source of sources) {
    const jobId = source.jobId?.trim();
    if (jobId && !params.jobExists(jobId)) {
      return false;
    }
  }

  const briefSource = sources.find(
    (s) =>
      s.jobId === dailyBriefJobId && s.tables?.includes("briefs"),
  );
  if (!briefSource) {
    return false;
  }

  const merged = mergeDailyBriefDataSource(
    briefSource,
    dailyBriefJobId,
    readTarget?.dbPath ?? "",
    readTarget?.dbId,
  );
  if (dailyBriefDataSourceNeedsUpdate(briefSource, merged)) {
    return false;
  }

  const dbPath = merged.dbPath?.trim() ?? "";
  if (
    readTarget?.dbPath &&
    isHomeDailyBriefRegistryDbPath(readTarget.dbPath) &&
    !isHomeDailyBriefRegistryDbPath(dbPath)
  ) {
    return false;
  }

  return true;
}
