/**
 * Short-TTL cache for Turso sync status reports (Settings + publish bar polling).
 */

import type { TursoSyncItemsReport } from "./tursoSyncStatus.js";

const DEFAULT_TTL_MS = Number(process.env.TURSO_SYNC_ITEMS_CACHE_TTL_MS ?? 45_000);

interface CacheEntry {
  report: TursoSyncItemsReport;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function tursoSyncItemsCacheKey(filterAppId?: string): string {
  return filterAppId ? `app:${filterAppId}` : "all";
}

export function getCachedTursoSyncItemsReport(
  key: string,
): TursoSyncItemsReport | null {
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.report;
}

export function setCachedTursoSyncItemsReport(
  key: string,
  report: TursoSyncItemsReport,
  ttlMs: number = DEFAULT_TTL_MS,
): void {
  cache.set(key, {
    report,
    expiresAt: Date.now() + ttlMs,
  });
}

/** Drop cached status for one app or the whole workspace. */
export function invalidateTursoSyncItemsCache(appId?: string): void {
  if (!appId) {
    cache.clear();
    return;
  }
  cache.delete(tursoSyncItemsCacheKey(appId));
  cache.delete("all");
}

export function clearTursoSyncItemsCacheForTests(): void {
  cache.clear();
}
