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

export async function readMemoryPreviewCache(): Promise<{
  paprMemory: CachedPaprMemory;
  status: CachedMemoryPreviewStatus;
  fetchedAt: string;
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
}): Promise<void> {
  const file: MemoryPreviewCacheFile = {
    version: 1,
    fetchedAt: new Date().toISOString(),
    paprMemory: input.paprMemory,
    status: input.status,
  };
  const dir = path.dirname(cachePath());
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${cachePath()}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), "utf-8");
  await fs.rename(tmp, cachePath());
}
