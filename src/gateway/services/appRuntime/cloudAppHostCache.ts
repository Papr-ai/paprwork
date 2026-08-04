/**
 * In-process caches for Cloud App Host — cuts repeated memory/GitHub hops per page load.
 */

import { createHash } from "node:crypto";
import type { AppAccessContext, AppPublishResolver, AppRuntimeRouteAuth } from "./types.js";
import { fetchRuntimeRepoFile } from "./memoryRuntimeClient.js";
import {
  gcsCacheGet,
  gcsCachePut,
  isGcsSharedCacheEnabled,
} from "./gcsSharedCache.js";
import {
  isMiniAppTypeScriptFile,
  transpileMiniAppTypeScript,
  type MiniAppTranspileResult,
} from "../../utils/miniAppTranspile.js";

import {
  CLOUD_REPO_HEAD_RELATIVE_PATH,
  parseCloudRepoHeadContent,
} from "../cloudSync/cloudRepoHeadMarker.js";
import {
  PAPR_APP_CLOUD_REVISION_PATH,
  parseAppCloudRevisionContent,
} from "../cloudSync/cloudAppRevisionMarker.js";

/**
 * Repo files: stale-while-revalidate for repeat viewers. Cache keys include the
 * per-app revision marker (`.papr-cloud-revision`, dist bundle hash) so syncing
 * one app does not bust caches for other apps in the same git repo. Legacy apps
 * without the marker fall back to repo-wide `data/cloud-repo-head.txt`.
 * Browser reload (F5) bypasses SWR via shouldBypassRepoFileCache().
 */
const REPO_FILE_FRESH_MS = 600_000;
const REPO_FILE_STALE_MS = 86_400_000;
const REPO_REVISION_TTL_MS = 5_000;
const ACCESS_TTL_MS = 300_000;
const TRANSPILE_TTL_MS = 3_600_000;

interface TimedEntry<T> {
  value: T;
  expiresAt: number;
}

interface SwrEntry<T> {
  value: T;
  freshUntil: number;
  staleUntil: number;
  revalidating?: boolean;
}

const repoFileCache = new Map<string, SwrEntry<{ content: string; contentType: string } | null>>();
const repoRevisionCache = new Map<string, TimedEntry<string>>();
const accessCache = new Map<string, TimedEntry<AppAccessContext | null>>();
const transpileCache = new Map<string, TimedEntry<MiniAppTranspileResult>>();


/** Sweep interval — purge expired entries every 5 minutes */
const SWEEP_INTERVAL_MS = 300_000;

function sweepExpired(): void {
  const now = Date.now();
  for (const [key, entry] of repoFileCache) {
    if (now > entry.staleUntil) repoFileCache.delete(key);
  }
  for (const cache of [accessCache, transpileCache, repoRevisionCache]) {
    for (const [key, entry] of cache) {
      if (now > (entry as TimedEntry<unknown>).expiresAt) {
        cache.delete(key);
      }
    }
  }
}

/** Periodic sweep so stale entries don't linger if never re-read */
const _sweepTimer = setInterval(sweepExpired, SWEEP_INTERVAL_MS);
// Allow Node to exit even if the timer is still alive
if (typeof _sweepTimer === "object" && "unref" in _sweepTimer) {
  _sweepTimer.unref();
}

function runtimeAuthKey(auth: AppRuntimeRouteAuth): string {
  const session = auth.sessionToken ? `s:${auth.sessionToken.slice(0, 12)}` : "";
  const apiKey = auth.paprApiKey ? `k:${auth.paprApiKey.slice(0, 12)}` : "";
  const share = auth.shareToken ?? "";
  return `${auth.namespaceId}:${auth.slug}:${share}:${session}:${apiKey}`;
}

function readTimed<T>(cache: Map<string, TimedEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function writeTimed<T>(
  cache: Map<string, TimedEntry<T>>,
  key: string,
  value: T,
  ttlMs: number,
): void {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function contentFingerprint(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function repoFileCacheKey(
  auth: AppRuntimeRouteAuth,
  revision: string,
  relativePath: string,
): string {
  return `${runtimeAuthKey(auth)}:${revision}:${relativePath}`;
}

async function getAppCacheRevision(
  auth: AppRuntimeRouteAuth,
  bypassRevisionCache: boolean,
): Promise<string> {
  const revKey = runtimeAuthKey(auth);
  if (!bypassRevisionCache) {
    const cached = readTimed(repoRevisionCache, revKey);
    if (cached !== undefined) {
      return cached;
    }
  }

  try {
    const markerFile = await fetchRuntimeRepoFile(auth, PAPR_APP_CLOUD_REVISION_PATH);
    if (markerFile) {
      const revision = parseAppCloudRevisionContent(markerFile.content);
      writeTimed(repoRevisionCache, revKey, revision, REPO_REVISION_TTL_MS);
      return revision;
    }

    const headFile = await fetchRuntimeRepoFile(auth, CLOUD_REPO_HEAD_RELATIVE_PATH);
    const revision = headFile ? parseCloudRepoHeadContent(headFile.content) : "0";
    writeTimed(repoRevisionCache, revKey, revision, REPO_REVISION_TTL_MS);
    return revision;
  } catch {
    return "0";
  }
}

function writeRepoFileEntry(
  key: string,
  value: { content: string; contentType: string } | null,
): void {
  // Never long-cache missing files — a transient GitHub/memory 404 must not
  // make published apps look dead for hours until desktop sync busts cache.
  if (!value) {
    repoFileCache.delete(key);
    return;
  }
  const now = Date.now();
  repoFileCache.set(key, {
    value,
    freshUntil: now + REPO_FILE_FRESH_MS,
    staleUntil: now + REPO_FILE_STALE_MS,
  });
}

export async function fetchCachedRuntimeRepoFile(
  auth: AppRuntimeRouteAuth,
  relativePath: string,
  opts?: {
    /**
     * Skip fresh/stale windows and refetch from origin (falling back to the
     * cached value on failure). Set when the browser reloads (F5 / hard reload)
     * so publishers see synced changes immediately.
     * Bypasses the GCS L2 cache too (it holds the same possibly-stale copy).
     */
    bypassFresh?: boolean;
  },
): Promise<{ content: string; contentType: string } | null> {
  const revision = await getAppCacheRevision(auth, opts?.bypassFresh === true);
  const key = repoFileCacheKey(auth, revision, relativePath);
  const now = Date.now();
  const entry = repoFileCache.get(key);

  if (opts?.bypassFresh) {
    try {
      const file = await fetchRuntimeRepoFile(auth, relativePath);
      writeRepoFileEntry(key, file);
      if (file && isGcsSharedCacheEnabled()) {
        gcsCachePut(key, file, Date.now() + REPO_FILE_FRESH_MS);
      }
      return file;
    } catch {
      // Origin refetch failed — fall back to cached hit only (never a cached miss).
      if (entry?.value && now <= entry.staleUntil) return entry.value;
      throw new Error(`Failed to fetch ${relativePath}`);
    }
  }

  if (entry?.value && now <= entry.freshUntil) {
    return entry.value;
  }

  if (entry?.value && now <= entry.staleUntil) {
    // Stale-while-revalidate: serve stale immediately, refresh in background.
    if (!entry.revalidating) {
      entry.revalidating = true;
      void fetchRuntimeRepoFile(auth, relativePath)
        .then((file) => writeRepoFileEntry(key, file))
        .catch(() => {
          // Keep serving stale on refresh failure; next request retries.
          entry.revalidating = false;
        });
    }
    return entry.value;
  }

  // L2: shared GCS cache — lets a fresh Cloud Run instance reuse content
  // another instance already fetched, skipping the memory-server chain.
  if (isGcsSharedCacheEnabled()) {
    const shared = await gcsCacheGet(key);
    if (shared && now <= shared.freshUntil) {
      writeRepoFileEntry(key, {
        content: shared.content,
        contentType: shared.contentType,
      });
      return { content: shared.content, contentType: shared.contentType };
    }
  }

  const file = await fetchRuntimeRepoFile(auth, relativePath);
  writeRepoFileEntry(key, file);
  if (file && isGcsSharedCacheEnabled()) {
    gcsCachePut(key, file, Date.now() + REPO_FILE_FRESH_MS);
  }
  return file;
}

export async function validateCachedAccess(
  publishResolver: AppPublishResolver,
  runtimeAuth: AppRuntimeRouteAuth,
): Promise<AppAccessContext | null> {
  const key = runtimeAuthKey(runtimeAuth);
  const cached = readTimed(accessCache, key);
  if (cached !== undefined) {
    return cached;
  }

  const access = await publishResolver.validateAccess({
    namespaceId: runtimeAuth.namespaceId,
    slug: runtimeAuth.slug,
    paprApiKey: runtimeAuth.paprApiKey,
    sessionToken: runtimeAuth.sessionToken,
    shareToken: runtimeAuth.shareToken,
  });
  // Do not negative-cache denials — shared cookies can briefly point at the wrong app.
  if (access !== null) {
    writeTimed(accessCache, key, access, ACCESS_TTL_MS);
  }
  return access;
}

export async function getCachedTranspiledTypeScript(
  auth: AppRuntimeRouteAuth,
  relativePath: string,
  content: string,
): Promise<MiniAppTranspileResult> {
  if (!isMiniAppTypeScriptFile(relativePath)) {
    return { success: true, code: content };
  }

  const key = `${runtimeAuthKey(auth)}:${relativePath}:${contentFingerprint(content)}`;
  const cached = readTimed(transpileCache, key);
  if (cached !== undefined) {
    return cached;
  }

  const result = await transpileMiniAppTypeScript(content, relativePath);
  writeTimed(transpileCache, key, result, TRANSPILE_TTL_MS);
  return result;
}

/** Browser cache policy for published app static assets. */
export function cacheControlForAppAsset(
  requestedPath: string,
  options: { transpiled?: boolean } = {},
): string | null {
  if (requestedPath === "index.html") {
    return "no-cache, must-revalidate";
  }
  if (requestedPath.startsWith("dist/")) {
    return "public, max-age=31536000, immutable";
  }
  const ext = requestedPath.slice(requestedPath.lastIndexOf(".")).toLowerCase();
  const staticExts = [
    ".css", ".js", ".mjs", ".ts", ".tsx", ".svg",
    ".woff", ".woff2", ".png", ".jpg", ".jpeg", ".webp", ".ico", ".json",
  ];
  if (staticExts.includes(ext)) {
    return options.transpiled
      ? "public, max-age=600, stale-while-revalidate=3600"
      : "public, max-age=3600, stale-while-revalidate=86400";
  }
  return null;
}

/** Reset caches (unit tests). */
export function resetCloudAppHostCachesForTests(): void {
  repoFileCache.clear();
  repoRevisionCache.clear();
  accessCache.clear();
  transpileCache.clear();
}

/** Drop cached repo files after desktop sync so the next fetch sees the new head. */
export function invalidateRepoCacheForPublishedApp(
  namespaceId: string,
  slug: string,
): void {
  const prefix = `${namespaceId}:${slug}:`;
  for (const key of repoFileCache.keys()) {
    if (key.startsWith(prefix)) {
      repoFileCache.delete(key);
    }
  }
  for (const key of repoRevisionCache.keys()) {
    if (key.startsWith(prefix)) {
      repoRevisionCache.delete(key);
    }
  }
}
