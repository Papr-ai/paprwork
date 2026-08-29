/**
 * In-process caches for Cloud App Host — cuts repeated memory/GitHub hops per page load.
 */

import { createHash } from "node:crypto";
import type { AppDataSourcesFile } from "../appDataSources.js";
import type {
  AppAccessContext,
  AppPublishResolver,
  AppRuntimeRouteAuth,
  AppRuntimeRepoCredentials,
} from "./types.js";
import { fetchRuntimeRepoFile, fetchRuntimeRepoCredentials } from "./memoryRuntimeClient.js";
import { isDirectGithubRepoFetchEnabled } from "./cloudAppHostDirectGithub.js";
import {
  fetchGithubRepoTextFile,
  repoCredentialsCacheTtlMs,
} from "./githubAppRepoClient.js";
import {
  gcsCacheDeleteByApp,
  gcsCacheDeleteByNamespace,
  gcsCacheGet,
  gcsCachePut,
  isGcsSharedCacheEnabled,
} from "./gcsSharedCache.js";
import { gcsDeploySnapshotGet, gcsDeploySnapshotDeleteByApp } from "./gcsDeploySnapshot.js";
import {
  invalidateBackendArtifactCacheForNamespace,
  invalidateBackendArtifactCacheForPublishedApp,
} from "./backendArtifactCache.js";
import {
  invalidateDbTokenCacheForNamespace,
  invalidateDbTokenCacheForPublishedApp,
} from "./dbTokenRuntimeCache.js";
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
import {
  PAPR_APP_META_RELATIVE_PATH,
  parseCloudAppMetaRevision,
} from "../cloudSync/cloudAppMeta.js";

/**
 * Repo files: stale-while-revalidate for repeat viewers. Cache keys include the
 * per-app revision marker (`.papr-cloud-revision`, dist bundle hash) so syncing
 * one app does not bust caches for other apps in the same git repo. Legacy apps
 * without the marker fall back to repo-wide `data/cloud-repo-head.txt`.
 * Browser hard reload bypasses SWR via shouldBypassRepoFileCache().
 * Normal F5 does not — revision markers bust caches after Sync now.
 */
const REPO_FILE_FRESH_MS = 600_000;
const REPO_FILE_STALE_MS = 86_400_000;
/** Revision marker rarely changes mid-session; longer TTL cuts memory hops on burst loads. */
const REPO_REVISION_TTL_MS = 60_000;
/** Publish/link permissions rarely change mid-session; bust on revision notify. */
const ACCESS_TTL_MS = 30 * 60 * 1000;
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
const revisionInflight = new Map<string, Promise<string>>();
const accessCache = new Map<string, TimedEntry<AppAccessContext | null>>();
const repoCredentialsCache = new Map<string, TimedEntry<AppRuntimeRepoCredentials>>();
const transpileCache = new Map<string, TimedEntry<MiniAppTranspileResult>>();

/** Parsed app db config (Phase 3.3) — keyed by namespace + slug + revision, not per-user auth. */
export interface AppDbConfigCacheEntry {
  config: AppDataSourcesFile;
  linkedContent?: string;
  databasesContent?: string;
}

const appDbConfigCache = new Map<string, SwrEntry<AppDbConfigCacheEntry>>();


/** Sweep interval — purge expired entries every 5 minutes */
const SWEEP_INTERVAL_MS = 300_000;

function sweepExpired(): void {
  const now = Date.now();
  for (const [key, entry] of repoFileCache) {
    if (now > entry.staleUntil) repoFileCache.delete(key);
  }
  for (const [key, entry] of appDbConfigCache) {
    if (now > entry.staleUntil) appDbConfigCache.delete(key);
  }
  for (const cache of [accessCache, transpileCache, repoRevisionCache, repoCredentialsCache]) {
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
  const visitor = auth.externalUserId ? `u:${auth.externalUserId}` : "";
  return `${auth.namespaceId}:${auth.slug}:${share}:${session}:${apiKey}:${visitor}`;
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

/** Published repo files are identical for all authorized readers of an app revision. */
function appCacheScopeKey(auth: AppRuntimeRouteAuth): string {
  return `${auth.namespaceId}:${auth.slug}`;
}

function repoFileCacheKey(
  auth: AppRuntimeRouteAuth,
  revision: string,
  relativePath: string,
): string {
  return `${appCacheScopeKey(auth)}:${revision}:${relativePath}`;
}

/** Per-app git revision for cache keys (`.papr-cloud-revision` or repo head). */
export async function resolveAppCacheRevision(
  auth: AppRuntimeRouteAuth,
  bypassRevisionCache = false,
): Promise<string> {
  return getAppCacheRevision(auth, bypassRevisionCache);
}

async function resolveRevisionFromOrigin(auth: AppRuntimeRouteAuth): Promise<string> {
  try {
    const fetchFile = (path: string) => fetchRuntimeRepoFileOrigin(auth, path);
    const [markerFile, metaFile, headFile] = await Promise.all([
      fetchFile(PAPR_APP_CLOUD_REVISION_PATH),
      fetchFile(PAPR_APP_META_RELATIVE_PATH),
      fetchFile(CLOUD_REPO_HEAD_RELATIVE_PATH),
    ]);
    if (markerFile) {
      return parseAppCloudRevisionContent(markerFile.content);
    }
    if (metaFile) {
      const meta = parseCloudAppMetaRevision(metaFile.content);
      if (meta?.distRevision && meta.distRevision !== "0") {
        return meta.distRevision;
      }
    }
    return headFile ? parseCloudRepoHeadContent(headFile.content) : "0";
  } catch {
    return "0";
  }
}

async function getAppCacheRevision(
  auth: AppRuntimeRouteAuth,
  bypassRevisionCache: boolean,
): Promise<string> {
  const revKey = appCacheScopeKey(auth);
  if (!bypassRevisionCache) {
    const cached = readTimed(repoRevisionCache, revKey);
    if (cached !== undefined) {
      return cached;
    }
  }

  const inflightKey = `${revKey}:${bypassRevisionCache ? "bypass" : "normal"}`;
  const inflight = revisionInflight.get(inflightKey);
  if (inflight) {
    return inflight;
  }

  const pending = resolveRevisionFromOrigin(auth)
    .then((revision) => {
      writeTimed(repoRevisionCache, revKey, revision, REPO_REVISION_TTL_MS);
      return revision;
    })
    .finally(() => {
      revisionInflight.delete(inflightKey);
    });
  revisionInflight.set(inflightKey, pending);
  return pending;
}

export function cacheRuntimeRepoCredentials(
  auth: Pick<
    AppRuntimeRouteAuth,
    "namespaceId" | "slug" | "paprApiKey" | "sessionToken" | "shareToken" | "externalUserId"
  >,
  credentials: AppRuntimeRepoCredentials,
): void {
  const key = runtimeAuthKey(auth as AppRuntimeRouteAuth);
  writeTimed(
    repoCredentialsCache,
    key,
    credentials,
    repoCredentialsCacheTtlMs(credentials.expiresAt),
  );
}

function readCachedRepoCredentials(
  auth: AppRuntimeRouteAuth,
): AppRuntimeRepoCredentials | undefined {
  return readTimed(repoCredentialsCache, runtimeAuthKey(auth));
}

async function fetchRuntimeRepoFileOrigin(
  auth: AppRuntimeRouteAuth,
  relativePath: string,
): Promise<{ content: string; contentType: string } | null> {
  if (isDirectGithubRepoFetchEnabled()) {
    let credentials = readCachedRepoCredentials(auth);
    if (!credentials) {
      try {
        credentials = await fetchRuntimeRepoCredentials(auth);
        cacheRuntimeRepoCredentials(auth, credentials);
      } catch (err) {
        console.warn(
          `[CloudAppHost] Runtime repo-credentials failed, falling back to memory repo-file: ` +
            `${(err as Error).message}`,
        );
      }
    }
    if (credentials) {
      try {
        return await fetchGithubRepoTextFile(credentials, relativePath);
      } catch (err) {
        console.warn(
          `[CloudAppHost] Direct GitHub fetch failed for ${relativePath}, ` +
            `falling back to memory repo-file: ${(err as Error).message}`,
        );
      }
    }
  }
  return fetchRuntimeRepoFile(auth, relativePath);
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
      const file = await fetchRuntimeRepoFileOrigin(auth, relativePath);
      writeRepoFileEntry(key, file);
      if (file && isGcsSharedCacheEnabled()) {
        gcsCachePut(key, file, Date.now() + REPO_FILE_FRESH_MS);
      }
      return file;
    } catch {
      // Origin refetch failed — fall back to cached hit only (never a cached miss).
      if (entry?.value && now <= entry.staleUntil) {
        return entry.value;
      }
      return null;
    }
  }

  if (entry?.value && now <= entry.freshUntil) {
    return entry.value;
  }

  if (entry?.value && now <= entry.staleUntil) {
    // Stale-while-revalidate: serve stale immediately, refresh in background.
    if (!entry.revalidating) {
      entry.revalidating = true;
      void fetchRuntimeRepoFileOrigin(auth, relativePath)
        .then((file) => writeRepoFileEntry(key, file))
        .catch(() => {
          // Keep serving stale on refresh failure; next request retries.
          entry.revalidating = false;
        });
    }
    return entry.value;
  }

  // DB config must match memory allowlist — never serve stale deploy snapshots.
  const skipDeploySnapshot =
    relativePath === "data-sources.json" ||
    relativePath === "linked-databases.json" ||
    relativePath === "data/databases.json";

  // L2b: immutable deploy snapshot (Sync now warm) — revision-pinned, no origin hop.
  if (!skipDeploySnapshot && isGcsSharedCacheEnabled()) {
    const snapshot = await gcsDeploySnapshotGet(
      auth.namespaceId,
      auth.slug,
      revision,
      relativePath,
    );
    if (snapshot) {
      const file = {
        content: snapshot.content,
        contentType: snapshot.contentType,
      };
      writeRepoFileEntry(key, file);
      return file;
    }
  }

  // L2: shared GCS cache — lets a fresh Cloud Run instance reuse content
  // another instance already fetched, skipping the memory-server chain.
  if (isGcsSharedCacheEnabled()) {
    const shared = await gcsCacheGet(key);
    if (shared) {
      const staleUntil =
        shared.freshUntil + (REPO_FILE_STALE_MS - REPO_FILE_FRESH_MS);
      if (now <= shared.freshUntil || now <= staleUntil) {
        writeRepoFileEntry(key, {
          content: shared.content,
          contentType: shared.contentType,
        });
        return { content: shared.content, contentType: shared.contentType };
      }
    }
  }

  const file = await fetchRuntimeRepoFileOrigin(auth, relativePath);
  writeRepoFileEntry(key, file);
  if (file && isGcsSharedCacheEnabled()) {
    gcsCachePut(key, file, Date.now() + REPO_FILE_FRESH_MS);
  }
  return file;
}

function appDbConfigCacheKey(
  namespaceId: string,
  slug: string,
  revision: string,
): string {
  return `${namespaceId}:${slug}:${revision}:app-db-config`;
}

export function readAppDbConfigCache(
  namespaceId: string,
  slug: string,
  revision: string,
): AppDbConfigCacheEntry | undefined {
  const key = appDbConfigCacheKey(namespaceId, slug, revision);
  const entry = appDbConfigCache.get(key);
  if (!entry) {
    return undefined;
  }
  if (Date.now() > entry.staleUntil) {
    appDbConfigCache.delete(key);
    return undefined;
  }
  return entry.value;
}

export function writeAppDbConfigCache(
  namespaceId: string,
  slug: string,
  revision: string,
  value: AppDbConfigCacheEntry,
): void {
  const key = appDbConfigCacheKey(namespaceId, slug, revision);
  const now = Date.now();
  appDbConfigCache.set(key, {
    value,
    freshUntil: now + REPO_FILE_FRESH_MS,
    staleUntil: now + REPO_FILE_STALE_MS,
  });
}

function invalidateAppDbConfigCacheByPrefix(prefix: string): void {
  for (const key of appDbConfigCache.keys()) {
    if (key.startsWith(prefix)) {
      appDbConfigCache.delete(key);
    }
  }
}

/** Drop cached data-sources + linked-databases bundle for one published app. */
export function invalidateAppDbConfigCacheForApp(
  namespaceId: string,
  slug: string,
): void {
  invalidateAppDbConfigCacheByPrefix(`${namespaceId}:${slug}:`);
}

export async function validateCachedAccess(
  publishResolver: AppPublishResolver,
  runtimeAuth: AppRuntimeRouteAuth,
  stats?: { cacheHit?: boolean },
): Promise<AppAccessContext | null> {
  const key = runtimeAuthKey(runtimeAuth);
  const cached = readTimed(accessCache, key);
  if (cached !== undefined) {
    if (stats) {
      stats.cacheHit = true;
    }
    return cached;
  }

  if (stats) {
    stats.cacheHit = false;
  }

  const access = await publishResolver.validateAccess({
    namespaceId: runtimeAuth.namespaceId,
    slug: runtimeAuth.slug,
    paprApiKey: runtimeAuth.paprApiKey,
    sessionToken: runtimeAuth.sessionToken,
    shareToken: runtimeAuth.shareToken,
    externalUserId: runtimeAuth.externalUserId,
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

/** Browser + CDN cache policy for published app static assets. */
export function cacheControlForAppAsset(
  requestedPath: string,
  options: { transpiled?: boolean } = {},
): { cacheControl: string; cdnCacheControl?: string } | null {
  if (requestedPath === "index.html") {
    return { cacheControl: "no-cache, must-revalidate" };
  }
  if (requestedPath.startsWith("dist/")) {
    return {
      cacheControl: "public, max-age=31536000, immutable",
      cdnCacheControl: "public, max-age=31536000, immutable",
    };
  }
  const ext = requestedPath.slice(requestedPath.lastIndexOf(".")).toLowerCase();
  const staticExts = [
    ".css", ".js", ".mjs", ".ts", ".tsx", ".svg",
    ".woff", ".woff2", ".png", ".jpg", ".jpeg", ".webp", ".ico", ".json",
  ];
  if (staticExts.includes(ext)) {
    const cacheControl = options.transpiled
      ? "public, max-age=600, stale-while-revalidate=3600"
      : "public, max-age=3600, stale-while-revalidate=86400";
    return {
      cacheControl,
      cdnCacheControl: cacheControl,
    };
  }
  return null;
}

/** @deprecated Use cacheControlForAppAsset return value — kept for callers expecting string. */
export function cacheControlHeaderForAppAsset(
  requestedPath: string,
  options: { transpiled?: boolean } = {},
): string | null {
  return cacheControlForAppAsset(requestedPath, options)?.cacheControl ?? null;
}

/** Reset caches (unit tests). */
export function resetCloudAppHostCachesForTests(): void {
  repoFileCache.clear();
  repoRevisionCache.clear();
  revisionInflight.clear();
  accessCache.clear();
  repoCredentialsCache.clear();
  transpileCache.clear();
  appDbConfigCache.clear();
}

function invalidateAccessCacheByPrefix(prefix: string): void {
  for (const key of accessCache.keys()) {
    if (key.startsWith(prefix)) {
      accessCache.delete(key);
    }
  }
}

/** Drop cached access after publish / permission changes (same key prefix as runtimeAuthKey). */
export function invalidateAccessCacheForPublishedApp(
  namespaceId: string,
  slug: string,
): void {
  invalidateAccessCacheByPrefix(`${namespaceId}:${slug}:`);
}

/** Broader access invalidation when publish slug is unknown. */
export function invalidateAccessCacheForNamespace(namespaceId: string): void {
  invalidateAccessCacheByPrefix(`${namespaceId}:`);
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
  for (const key of transpileCache.keys()) {
    if (key.startsWith(prefix)) {
      transpileCache.delete(key);
    }
  }
  invalidateAppDbConfigCacheByPrefix(prefix);
  invalidateAccessCacheForPublishedApp(namespaceId, slug);
  invalidateBackendArtifactCacheForPublishedApp(namespaceId, slug);
  invalidateDbTokenCacheForPublishedApp(namespaceId, slug);
  for (const key of repoCredentialsCache.keys()) {
    if (key.startsWith(prefix)) {
      repoCredentialsCache.delete(key);
    }
  }
  gcsCacheDeleteByApp(namespaceId, slug);
  gcsDeploySnapshotDeleteByApp(namespaceId, slug);
}

/** Broader invalidation when publish slug is unknown (Pub/Sub commit fanout). */
export function invalidateRepoCacheForNamespace(namespaceId: string): void {
  const prefix = `${namespaceId}:`;
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
  invalidateAppDbConfigCacheByPrefix(prefix);
  invalidateAccessCacheForNamespace(namespaceId);
  invalidateBackendArtifactCacheForNamespace(namespaceId);
  invalidateDbTokenCacheForNamespace(namespaceId);
  gcsCacheDeleteByNamespace(namespaceId);
}
