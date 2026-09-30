/**
 * MemoryPreviewCache — Local cache for Settings memory preview
 *
 * Workspace files are always read fresh from disk (fast).
 * Papr goals/OKRs/sync tiers are cached locally and refreshed at most once per day,
 * or on explicit refresh from the Settings UI.
 */

import { promises as fs } from "fs";
import { getPaprDataDir } from "../../core/utils/paprRoot.js";
import path from "path";

export const MEMORY_PREVIEW_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Back off background sync.getTiers retries after failure (matches syncTiersClient). */
export const MEMORY_PREVIEW_SYNC_TIERS_FAILURE_BACKOFF_MS = 30 * 60 * 1000;

export interface CachedMemoryPreviewStatus {
  paprConfigured: boolean;
  paprUserId: string | null;
  hasSessionToken: boolean;
  isLoggedIn: boolean;
  errors: {
    goals?: string;
    useCases?: string;
    syncTiers?: string;
  };
  /** True after sync.getTiers succeeded (even when both tiers are empty). */
  syncTiersFetched?: boolean;
}

export interface CachedPaprMemory {
  goalsOkrs: string | null;
  useCases: string | null;
  syncTiers: string | null;
}

interface MemoryPreviewCacheFile {
  version: 1;
  fetchedAt: string;
  /** ISO timestamp of the last failed sync.getTiers attempt (for client backoff). */
  syncTiersFailedAt?: string;
  paprMemory: CachedPaprMemory;
  status: CachedMemoryPreviewStatus;
}

function cachePath(): string {
  return path.join(getPaprDataDir(), "memory-preview-cache.json");
}

function isFresh(fetchedAt: string, ttlMs: number): boolean {
  const parsed = Date.parse(fetchedAt);
  if (Number.isNaN(parsed)) {
    return false;
  }
  return Date.now() - parsed < ttlMs;
}

/** Cache is incomplete when sync tiers failed or were never fetched — retry even if within TTL */
export function isMemoryPreviewCacheIncomplete(
  paprMemory: CachedPaprMemory,
  status: CachedMemoryPreviewStatus,
): boolean {
  if (!paprMemory.syncTiers && status.errors.syncTiers) {
    return true;
  }
  if (
    !paprMemory.syncTiers &&
    !status.errors.syncTiers &&
    status.isLoggedIn &&
    !status.syncTiersFetched
  ) {
    return true;
  }
  return false;
}

export function getSyncTiersFailureBackoffRemainingMs(
  syncTiersFailedAt: string | undefined,
  nowMs: number = Date.now(),
): number {
  if (!syncTiersFailedAt) {
    return 0;
  }
  const failedAt = Date.parse(syncTiersFailedAt);
  if (Number.isNaN(failedAt)) {
    return 0;
  }
  const elapsed = nowMs - failedAt;
  if (elapsed >= MEMORY_PREVIEW_SYNC_TIERS_FAILURE_BACKOFF_MS) {
    return 0;
  }
  return MEMORY_PREVIEW_SYNC_TIERS_FAILURE_BACKOFF_MS - elapsed;
}

/** Whether a background refresh should be queued (respects TTL + failure backoff). */
export function shouldQueueMemoryPreviewRefresh(input: {
  isFresh: boolean;
  isIncomplete: boolean;
  syncTiersFailedAt?: string;
  previewRefreshInFlight?: boolean;
  nowMs?: number;
}): boolean {
  if (input.previewRefreshInFlight) {
    return false;
  }
  if (input.isFresh && !input.isIncomplete) {
    return false;
  }
  if (
    getSyncTiersFailureBackoffRemainingMs(
      input.syncTiersFailedAt,
      input.nowMs,
    ) > 0
  ) {
    return false;
  }
  return true;
}

export async function readMemoryPreviewCache(): Promise<{
  paprMemory: CachedPaprMemory;
  status: CachedMemoryPreviewStatus;
  fetchedAt: string;
  syncTiersFailedAt?: string;
  isFresh: boolean;
  isIncomplete: boolean;
} | null> {
  try {
    const raw = await fs.readFile(cachePath(), "utf-8");
    const data = JSON.parse(raw) as MemoryPreviewCacheFile;
    if (data.version !== 1 || !data.fetchedAt) {
      return null;
    }
    return {
      paprMemory: data.paprMemory,
      status: data.status,
      fetchedAt: data.fetchedAt,
      syncTiersFailedAt: data.syncTiersFailedAt,
      isFresh: isFresh(data.fetchedAt, MEMORY_PREVIEW_CACHE_TTL_MS),
      isIncomplete: isMemoryPreviewCacheIncomplete(
        data.paprMemory,
        data.status,
      ),
    };
  } catch {
    return null;
  }
}

export async function clearMemoryPreviewCache(): Promise<void> {
  try {
    await fs.unlink(cachePath());
  } catch {
    // Cache may not exist
  }
}

export async function writeMemoryPreviewCache(input: {
  paprMemory: CachedPaprMemory;
  status: CachedMemoryPreviewStatus;
  syncTiersFailedAt?: string | null;
}): Promise<void> {
  const file: MemoryPreviewCacheFile = {
    version: 1,
    fetchedAt: new Date().toISOString(),
    syncTiersFailedAt: input.syncTiersFailedAt ?? undefined,
    paprMemory: input.paprMemory,
    status: input.status,
  };
  const dir = path.dirname(cachePath());
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${cachePath()}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), "utf-8");
  await fs.rename(tmp, cachePath());
}
