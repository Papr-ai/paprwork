/**
 * Repair stale absolute dbPath values in data-sources.json after workspace migration.
 *
 * Legacy layouts stored paths like ~/Papr/jobs/{id}/data/data.db while active
 * workspace uses ~/Papr/orgs/{org}/namespaces/{ns}/Jobs/{id}/data/data.db.
 * Sources with jobId are re-resolved from the current Jobs root on every init.
 */

import { existsSync } from "fs";
import path from "path";
import { getPaprDataDir } from "../../core/utils/paprRoot.js";
import type { AppDataSourcesFile, AppDataSource } from "./appDataSources.js";
import { resolveReadableRegistryDbPath } from "./resolveRegistryDbPath.js";

export interface JobDatabasePathResolver {
  getJobDatabasePath(jobId: string): Promise<string | null> | string | null;
}

export interface DataSourcePathRepairResult {
  appId: string;
  alias: string;
  jobId?: string;
  fromPath: string;
  toPath: string;
}

function pathsEqual(a: string, b: string): boolean {
  return path.normalize(a) === path.normalize(b);
}

async function resolveCanonicalJobDbPath(
  resolver: JobDatabasePathResolver,
  jobId: string,
): Promise<string | null> {
  const result = resolver.getJobDatabasePath(jobId);
  return result instanceof Promise ? await result : result;
}

async function repairRegistryBackedSource(
  appId: string,
  source: AppDataSource,
  repairs: DataSourcePathRepairResult[],
): Promise<AppDataSource> {
  const storedPath = source.dbPath?.trim() ?? "";
  const { getDatabaseRegistryService } = await import(
    "./DatabaseRegistryService.js"
  );
  const registry = getDatabaseRegistryService();
  const record = source.dbId ? registry.getById(source.dbId) : undefined;
  const dataDir = getPaprDataDir();

  const resolved = resolveReadableRegistryDbPath({
    dbPath: source.dbPath,
    registryPath: record?.localPath,
    dataDir,
  });

  if (!resolved || pathsEqual(resolved, storedPath)) {
    return source;
  }

  repairs.push({
    appId,
    alias: source.alias,
    fromPath: storedPath.length > 0 ? storedPath : "(empty)",
    toPath: resolved,
  });

  if (
    source.dbId &&
    record &&
    !pathsEqual(record.localPath?.trim() ?? "", resolved)
  ) {
    await registry.updateLocalPath(source.dbId, resolved);
  }

  return { ...source, dbPath: resolved };
}

/**
 * Returns updated config when any source dbPath was repaired.
 */
export async function repairDataSourceDbPathsInConfig(
  appId: string,
  config: AppDataSourcesFile,
  resolver: JobDatabasePathResolver,
): Promise<{ config: AppDataSourcesFile; repairs: DataSourcePathRepairResult[] }> {
  const repairs: DataSourcePathRepairResult[] = [];
  const sources: AppDataSource[] = [];

  for (const source of config.sources ?? []) {
    if (!source.jobId) {
      const repairedSource = await repairRegistryBackedSource(appId, source, repairs);
      sources.push(repairedSource);
      continue;
    }

    const canonical = await resolveCanonicalJobDbPath(resolver, source.jobId);
    if (!canonical) {
      sources.push(source);
      continue;
    }

    const storedPath = source.dbPath?.trim() ?? "";
    const storedExists = storedPath.length > 0 && existsSync(storedPath);
    const canonicalExists = existsSync(canonical);

    if (
      canonicalExists &&
      storedPath.length > 0 &&
      !pathsEqual(storedPath, canonical)
    ) {
      repairs.push({
        appId,
        alias: source.alias,
        jobId: source.jobId,
        fromPath: storedPath,
        toPath: canonical,
      });
      sources.push({ ...source, dbPath: canonical });
      continue;
    }

    if (!storedExists && canonicalExists) {
      if (!pathsEqual(storedPath, canonical)) {
        repairs.push({
          appId,
          alias: source.alias,
          jobId: source.jobId,
          fromPath: storedPath.length > 0 ? storedPath : "(empty)",
          toPath: canonical,
        });
        sources.push({ ...source, dbPath: canonical });
      } else {
        sources.push(source);
      }
      continue;
    }

    sources.push(source);
  }

  if (repairs.length === 0) {
    return { config, repairs };
  }

  return {
    config: { ...config, sources },
    repairs,
  };
}
