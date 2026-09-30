/**
 * Revision-keyed backend artifact cache — avoids re-fetching and re-parsing
 * manifest/bundle/handlers on every /api/app/backend/:action call.
 */

import type { AppBackendManifest } from "../../../core/types/appBackend.js";
import type { AppBackendBundleManifest } from "../../utils/miniAppBackendBuild.js";
import { parseAppBackendManifest } from "./appBackendManifest.js";
import type { AppRuntimeRouteAuth } from "./types.js";
import { fetchCachedRuntimeRepoFile, resolveAppCacheRevision } from "./cloudAppHostCache.js";

const BACKEND_MANIFEST_PATH = "backend/manifest.json";
const BACKEND_BUNDLE_PATH = "backend/bundle.json";

export interface BackendRevisionArtifacts {
  manifestContent: string;
  manifest: AppBackendManifest;
  bundleContent: string | null;
  bundle: AppBackendBundleManifest | null;
  handlers: Map<string, string>;
}

const artifactCache = new Map<string, BackendRevisionArtifacts>();

function artifactCacheKey(
  namespaceId: string,
  slug: string,
  revision: string,
): string {
  return `${namespaceId}:${slug}:${revision}:backend-artifacts`;
}

export async function loadBackendRevisionArtifacts(
  auth: AppRuntimeRouteAuth,
  opts?: { bypassFresh?: boolean },
): Promise<BackendRevisionArtifacts> {
  const revision = await resolveAppCacheRevision(auth, opts?.bypassFresh === true);
  const key = artifactCacheKey(auth.namespaceId, auth.slug, revision);
  const cached = artifactCache.get(key);
  if (cached) {
    return cached;
  }

  const cacheOpts = opts?.bypassFresh ? { bypassFresh: true as const } : undefined;
  const [manifestFile, bundleFile] = await Promise.all([
    fetchCachedRuntimeRepoFile(auth, BACKEND_MANIFEST_PATH, cacheOpts),
    fetchCachedRuntimeRepoFile(auth, BACKEND_BUNDLE_PATH, cacheOpts),
  ]);
  if (!manifestFile) {
    throw new Error(`Backend manifest not found for ${auth.namespaceId}/${auth.slug}`);
  }

  const manifest = parseAppBackendManifest(
    JSON.parse(manifestFile.content) as unknown,
  );
  let bundle: AppBackendBundleManifest | null = null;
  if (bundleFile) {
    bundle = JSON.parse(bundleFile.content) as AppBackendBundleManifest;
  }

  const entry: BackendRevisionArtifacts = {
    manifestContent: manifestFile.content,
    manifest,
    bundleContent: bundleFile?.content ?? null,
    bundle,
    handlers: new Map(),
  };
  artifactCache.set(key, entry);
  return entry;
}

export async function loadBackendHandlerContent(
  auth: AppRuntimeRouteAuth,
  handlerPath: string,
  artifacts: BackendRevisionArtifacts,
  opts?: { bypassFresh?: boolean },
): Promise<string> {
  const cached = artifacts.handlers.get(handlerPath);
  if (cached !== undefined) {
    return cached;
  }

  const cacheOpts = opts?.bypassFresh ? { bypassFresh: true as const } : undefined;
  const handlerFile = await fetchCachedRuntimeRepoFile(auth, handlerPath, cacheOpts);
  if (!handlerFile) {
    throw new Error(`Backend handler not found: ${handlerPath}`);
  }
  artifacts.handlers.set(handlerPath, handlerFile.content);
  return handlerFile.content;
}

export function invalidateBackendArtifactCacheForPublishedApp(
  namespaceId: string,
  slug: string,
): void {
  const prefix = `${namespaceId}:${slug}:`;
  for (const key of artifactCache.keys()) {
    if (key.startsWith(prefix)) {
      artifactCache.delete(key);
    }
  }
}

export function invalidateBackendArtifactCacheForNamespace(
  namespaceId: string,
): void {
  const prefix = `${namespaceId}:`;
  for (const key of artifactCache.keys()) {
    if (key.startsWith(prefix)) {
      artifactCache.delete(key);
    }
  }
}

/** Reset caches (unit tests). */
export function resetBackendArtifactCacheForTests(): void {
  artifactCache.clear();
}
