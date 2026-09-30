/**
 * Instant Team / Community Apps catalog — sessionStorage cache, refreshed from gateway.
 */

import type { CommunityCatalog } from "../../src/core/types/communityCatalog.js";

const CACHE_PREFIX = "papr-community-catalog:";
const CACHE_TTL_MS = 30 * 60_000;

interface CachedCommunityCatalog {
  catalog: CommunityCatalog;
  updatedAt: string;
}

function cacheKey(scope: "global" | "namespace", namespaceId: string | null): string {
  return scope === "namespace" && namespaceId
    ? `${CACHE_PREFIX}namespace:${namespaceId}`
    : `${CACHE_PREFIX}global`;
}

export function readCommunityCatalogCache(
  scope: "global" | "namespace",
  namespaceId: string | null,
): CommunityCatalog | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(scope, namespaceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedCommunityCatalog>;
    if (!parsed.catalog || typeof parsed.updatedAt !== "string") return null;
    const ageMs = Date.now() - Date.parse(parsed.updatedAt);
    if (!Number.isFinite(ageMs) || ageMs > CACHE_TTL_MS) return null;
    if (
      scope === "namespace" &&
      namespaceId &&
      parsed.catalog.namespaceId &&
      parsed.catalog.namespaceId !== namespaceId
    ) {
      return null;
    }
    return { ...parsed.catalog, fromCache: true };
  } catch {
    return null;
  }
}

export function writeCommunityCatalogCache(
  scope: "global" | "namespace",
  namespaceId: string | null,
  catalog: CommunityCatalog,
): void {
  try {
    const next: CachedCommunityCatalog = {
      catalog: { ...catalog, fromCache: undefined },
      updatedAt: new Date().toISOString(),
    };
    sessionStorage.setItem(cacheKey(scope, namespaceId), JSON.stringify(next));
  } catch {
    /* quota / private mode */
  }
}

export function clearCommunityCatalogCache(): void {
  try {
    const keysToRemove: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(CACHE_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      sessionStorage.removeItem(key);
    }
  } catch {
    /* ignore */
  }
}
