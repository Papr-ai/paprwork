/**
 * Short-lived cache for Settings → Cloud Sync `/api/sync/items` payloads.
 */

import type { CloudLinkSyncReport } from "./cloudPublishStatus.js";

const DEFAULT_TTL_MS = 30_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

let cloudLinksCache: CacheEntry<CloudLinkSyncReport> | null = null;

export function getCachedCloudLinkSyncReport(): CloudLinkSyncReport | null {
  if (!cloudLinksCache || Date.now() >= cloudLinksCache.expiresAt) {
    return null;
  }
  return cloudLinksCache.value;
}

export function setCachedCloudLinkSyncReport(
  report: CloudLinkSyncReport,
  ttlMs: number = DEFAULT_TTL_MS,
): void {
  cloudLinksCache = {
    value: report,
    expiresAt: Date.now() + ttlMs,
  };
}

export function invalidateCloudLinkSyncReportCache(): void {
  cloudLinksCache = null;
}
