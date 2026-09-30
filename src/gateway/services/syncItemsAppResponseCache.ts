/**
 * Short-TTL cache for per-app GET /api/sync/items payloads (without refresh=1).
 * Turso layer is cached separately; this avoids rebuilding appSyncV3 / publish / oversized on every poll.
 */

const DEFAULT_TTL_MS = Number(process.env.SYNC_ITEMS_APP_CACHE_TTL_MS ?? 20_000);

interface CacheEntry {
  payload: Record<string, unknown>;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function getCachedSyncItemsAppResponse(
  appId: string,
): Record<string, unknown> | null {
  const entry = cache.get(appId);
  if (!entry) {
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    cache.delete(appId);
    return null;
  }
  return entry.payload;
}

export function setCachedSyncItemsAppResponse(
  appId: string,
  payload: Record<string, unknown>,
  ttlMs: number = DEFAULT_TTL_MS,
): void {
  cache.set(appId, {
    payload,
    expiresAt: Date.now() + ttlMs,
  });
}

export function invalidateSyncItemsAppResponseCache(appId?: string): void {
  if (!appId) {
    cache.clear();
    return;
  }
  cache.delete(appId);
}

export function clearSyncItemsAppResponseCacheForTests(): void {
  cache.clear();
}
