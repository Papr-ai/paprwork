/**
 * Last-synced blob OID per (appId, repo-relative path).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { SYNC_OID_CACHE_FILENAME } from "../../../core/types/appRepoWriterOps.js";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";

export interface OidCacheFile {
  version: 1;
  updatedAt: string;
  /** appId → repo-relative path → blob OID */
  apps: Record<string, Record<string, string>>;
}

function cachePath(): string {
  return path.join(getPaprRoot(), "data", SYNC_OID_CACHE_FILENAME);
}

function emptyCache(): OidCacheFile {
  return { version: 1, updatedAt: new Date(0).toISOString(), apps: {} };
}

export async function readOidCache(): Promise<OidCacheFile> {
  try {
    const raw = await fs.readFile(cachePath(), "utf8");
    const parsed = JSON.parse(raw) as OidCacheFile;
    if (parsed.version !== 1 || typeof parsed.apps !== "object") {
      return emptyCache();
    }
    return parsed;
  } catch {
    return emptyCache();
  }
}

async function writeOidCache(cache: OidCacheFile): Promise<void> {
  cache.updatedAt = new Date().toISOString();
  const filePath = cachePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(cache, null, 2), "utf8");
}

export async function getCachedBlobOid(
  appId: string,
  repoRelativePath: string,
): Promise<string | null> {
  const cache = await readOidCache();
  return cache.apps[appId]?.[repoRelativePath] ?? null;
}

export async function setCachedBlobOid(
  appId: string,
  repoRelativePath: string,
  blobOid: string,
): Promise<void> {
  const cache = await readOidCache();
  if (!cache.apps[appId]) {
    cache.apps[appId] = {};
  }
  cache.apps[appId][repoRelativePath] = blobOid;
  await writeOidCache(cache);
}

export async function applyAckedBlobOids(
  appId: string,
  files: ReadonlyArray<{ path: string; blobOid: string }>,
): Promise<void> {
  const cache = await readOidCache();
  if (!cache.apps[appId]) {
    cache.apps[appId] = {};
  }
  for (const file of files) {
    cache.apps[appId][file.path] = file.blobOid;
  }
  await writeOidCache(cache);
}

export async function invalidateCachedPath(
  appId: string,
  repoRelativePath: string,
): Promise<void> {
  const cache = await readOidCache();
  if (cache.apps[appId]?.[repoRelativePath]) {
    delete cache.apps[appId][repoRelativePath];
    await writeOidCache(cache);
  }
}

export async function removeAppFromOidCache(
  appId: string,
  paprHome?: string,
): Promise<boolean> {
  const trimmed = appId.trim();
  if (!trimmed) {
    return false;
  }
  const filePath = paprHome
    ? path.join(paprHome, "data", SYNC_OID_CACHE_FILENAME)
    : cachePath();
  let cache: OidCacheFile;
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as OidCacheFile;
    if (parsed.version !== 1 || typeof parsed.apps !== "object") {
      return false;
    }
    cache = parsed;
  } catch {
    return false;
  }
  if (!cache.apps[trimmed]) {
    return false;
  }
  delete cache.apps[trimmed];
  await writeOidCacheAtPath(filePath, cache);
  return true;
}

async function writeOidCacheAtPath(
  filePath: string,
  cache: OidCacheFile,
): Promise<void> {
  cache.updatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(cache, null, 2), "utf8");
}

export async function seedOidCacheFromHead(
  appId: string,
  files: ReadonlyArray<{ path: string; blobOid: string }>,
): Promise<void> {
  const cache = await readOidCache();
  if (!cache.apps[appId]) {
    cache.apps[appId] = {};
  }
  for (const file of files) {
    if (!cache.apps[appId][file.path]) {
      cache.apps[appId][file.path] = file.blobOid;
    }
  }
  await writeOidCache(cache);
}

/** Test-only — reset cache file. */
export async function clearOidCacheForTests(): Promise<void> {
  await fs.rm(cachePath(), { force: true });
}
