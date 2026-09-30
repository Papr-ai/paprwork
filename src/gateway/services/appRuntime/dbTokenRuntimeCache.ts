/**
 * In-process Turso db-token cache for Cloud App Host.
 */

import type { AppRuntimeRouteAuth } from "./types.js";

interface DbTokenCacheEntry {
  tursoUrl: string;
  authToken: string;
  expiresAt: number;
}

const dbTokenCache = new Map<string, DbTokenCacheEntry>();
/** Fallback when memory omits expiresAt (should not happen in production). */
const DB_TOKEN_FALLBACK_TTL_MS = 50 * 60 * 1000;
/** Refresh one minute before server-reported expiry. */
const DB_TOKEN_EXPIRY_SAFETY_MS = 60_000;

/** Cache until shortly before memory/Turso token expiry. Exported for tests. */
export function dbTokenCacheExpiresAt(
  expiresAtIso: string | undefined,
  now = Date.now(),
): number {
  if (expiresAtIso) {
    const expiresMs = new Date(expiresAtIso).getTime();
    if (Number.isFinite(expiresMs)) {
      return Math.max(now + DB_TOKEN_EXPIRY_SAFETY_MS, expiresMs - DB_TOKEN_EXPIRY_SAFETY_MS);
    }
  }
  return now + DB_TOKEN_FALLBACK_TTL_MS;
}

export function dbTokenCacheKey(auth: AppRuntimeRouteAuth, database: string): string {
  return [
    auth.namespaceId,
    auth.slug,
    auth.sessionToken ?? "",
    auth.shareToken ?? "",
    auth.paprApiKey ?? "",
    auth.externalUserId ?? "",
    database,
  ].join("|");
}

export function readDbTokenCache(
  cacheKey: string,
  now = Date.now(),
): { tursoUrl: string; authToken: string } | undefined {
  const cached = dbTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { tursoUrl: cached.tursoUrl, authToken: cached.authToken };
  }
  if (cached) {
    dbTokenCache.delete(cacheKey);
  }
  return undefined;
}

export function writeDbTokenCache(
  cacheKey: string,
  entry: { tursoUrl: string; authToken: string; expiresAt: number },
): void {
  dbTokenCache.set(cacheKey, entry);
}

/** Drop cached Turso credentials after publish/access changes. */
export function invalidateDbTokenCacheForPublishedApp(
  namespaceId: string,
  slug: string,
): void {
  const prefix = `${namespaceId}:${slug}:`;
  for (const key of dbTokenCache.keys()) {
    if (key.startsWith(prefix)) {
      dbTokenCache.delete(key);
    }
  }
}

/** Broader invalidation when publish slug is unknown. */
export function invalidateDbTokenCacheForNamespace(namespaceId: string): void {
  const prefix = `${namespaceId}:`;
  for (const key of dbTokenCache.keys()) {
    if (key.startsWith(prefix)) {
      dbTokenCache.delete(key);
    }
  }
}

/** Reset caches (unit tests). */
export function resetDbTokenCacheForTests(): void {
  dbTokenCache.clear();
}
