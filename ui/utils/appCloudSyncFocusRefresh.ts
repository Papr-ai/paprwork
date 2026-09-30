/** Debounce rapid app-tab switches before hitting /api/sync/items. */
export const APP_CLOUD_SYNC_FOCUS_DEBOUNCE_MS = 450;

/**
 * Client-side freshness for cached sync snapshots (display only — status is manual).
 * Aligns with gateway SYNC_ITEMS_APP_CACHE_TTL (~20s).
 */
export const APP_CLOUD_SYNC_CLIENT_FRESH_MS = 25_000;

export function isAppCloudSyncCacheFresh(
  fetchedAtMs: number | null,
  nowMs: number = Date.now(),
): boolean {
  if (fetchedAtMs === null || !Number.isFinite(fetchedAtMs)) {
    return false;
  }
  return nowMs - fetchedAtMs < APP_CLOUD_SYNC_CLIENT_FRESH_MS;
}
