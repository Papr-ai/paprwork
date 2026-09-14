/**
 * Resolved app data-sources cache (data-sources.json + linked-databases + registry
 * paths merged via resolveLinkedSourceDbPath).
 *
 * Invalidation: file stat (mtime/size/inode), workspace/job-link epoch bumps,
 * per-app manual bump, workspace switch clears all.
 */

import * as fs from "fs";
import type { AppDataSourcesFile } from "./appDataSources.js";

interface CacheEntry {
  signature: string;
  value: AppDataSourcesFile;
}

const MAX_ENTRIES = 2_000;
const cache = new Map<string, CacheEntry>();
const missCounts = new Map<string, number>();

let globalEpoch = 0;
const perAppEpoch = new Map<string, number>();

function fileSignature(filePath: string): string {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    return `${stat.mtimeNs}:${stat.size}:${stat.ino}`;
  } catch {
    return "missing";
  }
}

export interface AppDataSourcesCacheSignatureInput {
  appId: string;
  appsDir: string;
  paprRoot: string;
  jobsRoot: string;
  registryPath: string;
}

export function buildAppDataSourcesCacheSignature(
  input: AppDataSourcesCacheSignatureInput,
): string {
  const appDir = `${input.appsDir}/${input.appId}`.replace(/\\/g, "/");
  const appEpoch = perAppEpoch.get(input.appId) ?? 0;
  return [
    globalEpoch,
    appEpoch,
    input.paprRoot,
    input.jobsRoot,
    fileSignature(`${appDir}/data-sources.json`),
    fileSignature(`${appDir}/linked-databases.json`),
    fileSignature(input.registryPath),
  ].join("|");
}

export function getCachedAppDataSourcesResolvedConfig(
  appId: string,
  signature: string,
): AppDataSourcesFile | undefined {
  const entry = cache.get(appId);
  if (!entry || entry.signature !== signature) {
    return undefined;
  }
  return structuredClone(entry.value);
}

export function setCachedAppDataSourcesResolvedConfig(
  appId: string,
  signature: string,
  config: AppDataSourcesFile,
): void {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) {
      cache.delete(oldest.value);
    }
  }
  cache.set(appId, {
    signature,
    value: structuredClone(config),
  });
}

/** Drop one app or all apps (workspace switch, topology change). */
export function invalidateAppDataSourcesConfigCache(appId?: string): void {
  if (appId) {
    perAppEpoch.set(appId, (perAppEpoch.get(appId) ?? 0) + 1);
    cache.delete(appId);
    return;
  }
  globalEpoch += 1;
  cache.clear();
  perAppEpoch.clear();
}

/** After job/app link topology changes — any app may resolve job paths differently. */
export function bumpAppDataSourcesResolvedCacheForJobTopologyChange(): void {
  globalEpoch += 1;
  cache.clear();
}

export function recordAppDataSourcesConfigCacheMiss(appId: string): void {
  missCounts.set(appId, (missCounts.get(appId) ?? 0) + 1);
}

export function getAppDataSourcesConfigCacheMissCount(appId: string): number {
  return missCounts.get(appId) ?? 0;
}

export function clearAppDataSourcesConfigCacheDiagnostics(): void {
  missCounts.clear();
}
