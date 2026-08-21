/**
 * Local cache for server-resolved per-app repo metadata.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type {
  AppRepoRecord,
  AppRepoRegistryCacheFile,
} from "../../../core/types/appRepoRegistry.js";
import { APP_REPO_REGISTRY_CACHE_FILENAME } from "../../../core/types/appRepoRegistry.js";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";

function cachePath(): string {
  return path.join(getPaprRoot(), "data", APP_REPO_REGISTRY_CACHE_FILENAME);
}

export async function readAppRepoRegistryCache(): Promise<AppRepoRegistryCacheFile> {
  try {
    const raw = await fs.readFile(cachePath(), "utf8");
    const parsed = JSON.parse(raw) as AppRepoRegistryCacheFile;
    if (parsed.version !== 1 || typeof parsed.records !== "object") {
      return emptyCache();
    }
    return parsed;
  } catch {
    return emptyCache();
  }
}

export async function getCachedAppRepoRecord(
  appId: string,
): Promise<AppRepoRecord | null> {
  const cache = await readAppRepoRegistryCache();
  return cache.records[appId] ?? null;
}

export async function upsertCachedAppRepoRecord(
  record: AppRepoRecord,
): Promise<void> {
  const cache = await readAppRepoRegistryCache();
  cache.records[record.appId] = record;
  cache.updatedAt = new Date().toISOString();
  const filePath = cachePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(cache, null, 2), "utf8");
}

function emptyCache(): AppRepoRegistryCacheFile {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    records: {},
  };
}

/** Test-only — reset cache file. */
export async function clearAppRepoRegistryCacheForTests(): Promise<void> {
  await fs.rm(cachePath(), { force: true });
}
