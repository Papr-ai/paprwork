/**
 * Client-side throttle for Papr sync.getTiers — single-flight + failure backoff.
 *
 * Prevents desktop stampede when Settings preview or chat bootstrap retries
 * overlap while the memory server is slow or returning 429.
 */

import type { MemoryObject } from "@papr/memory/resources/shared.js";
import type Papr from "@papr/memory";
import { buildPaprMemoryUserIdentity } from "../../core/utils/paprMemoryUserIdentity.js";

/** Wait 30 minutes after a failed tiers fetch before retrying (background paths). */
export const SYNC_TIERS_FAILURE_BACKOFF_MS = 30 * 60 * 1000;

export class SyncTiersBackoffError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(
      `sync.getTiers backoff active — retry in ${Math.ceil(retryAfterMs / 1000)}s`,
    );
    this.name = "SyncTiersBackoffError";
    this.retryAfterMs = retryAfterMs;
  }
}

export interface SyncTiersFetchParams {
  max_tier0: number;
  max_tier1: number;
  include_embeddings: boolean;
}

export interface SyncTiersFetchResult {
  tier0: MemoryObject[];
  tier1: MemoryObject[];
}

interface SyncTiersFetchOptions {
  timeout?: number;
  /** User-initiated refresh bypasses failure backoff but still dedupes in-flight calls. */
  force?: boolean;
}

const inFlightByUser = new Map<string, Promise<SyncTiersFetchResult>>();
const lastFailedAtByUser = new Map<string, number>();

export function seedSyncTiersFailureFromCache(
  userId: string,
  failedAtIso: string | undefined,
): void {
  if (!failedAtIso) {
    return;
  }
  const parsed = Date.parse(failedAtIso);
  if (!Number.isNaN(parsed)) {
    lastFailedAtByUser.set(userId, parsed);
  }
}

export function getSyncTiersRetryAfterMs(
  userId: string,
  nowMs: number = Date.now(),
): number {
  const lastFailedAt = lastFailedAtByUser.get(userId);
  if (lastFailedAt === undefined) {
    return 0;
  }
  const elapsed = nowMs - lastFailedAt;
  if (elapsed >= SYNC_TIERS_FAILURE_BACKOFF_MS) {
    return 0;
  }
  return SYNC_TIERS_FAILURE_BACKOFF_MS - elapsed;
}

export function shouldAttemptSyncTiers(
  userId: string,
  nowMs: number = Date.now(),
): boolean {
  return getSyncTiersRetryAfterMs(userId, nowMs) === 0;
}

export function recordSyncTiersFailure(
  userId: string,
  atMs: number = Date.now(),
): void {
  lastFailedAtByUser.set(userId, atMs);
}

export function clearSyncTiersFailure(userId: string): void {
  lastFailedAtByUser.delete(userId);
}

export function hasSyncTiersInFlight(userId: string): boolean {
  return inFlightByUser.has(userId);
}

export async function fetchSyncTiersThrottled(
  client: Papr,
  userId: string,
  params: SyncTiersFetchParams,
  options: SyncTiersFetchOptions = {},
): Promise<SyncTiersFetchResult> {
  if (!options.force) {
    const retryAfterMs = getSyncTiersRetryAfterMs(userId);
    if (retryAfterMs > 0) {
      throw new SyncTiersBackoffError(retryAfterMs);
    }
  }

  const existing = inFlightByUser.get(userId);
  if (existing) {
    return existing;
  }

  const promise = (async (): Promise<SyncTiersFetchResult> => {
    try {
      const tiersResult = await client.sync.getTiers(
        {
          ...buildPaprMemoryUserIdentity(userId),
          max_tier0: params.max_tier0,
          max_tier1: params.max_tier1,
          include_embeddings: params.include_embeddings,
        },
        options.timeout !== undefined ? { timeout: options.timeout } : undefined,
      );
      clearSyncTiersFailure(userId);
      return {
        tier0: tiersResult.tier0 ?? [],
        tier1: tiersResult.tier1 ?? [],
      };
    } catch (error) {
      recordSyncTiersFailure(userId);
      throw error;
    } finally {
      inFlightByUser.delete(userId);
    }
  })();

  inFlightByUser.set(userId, promise);
  return promise;
}

/** Test helper — reset in-memory throttle state between vitest cases. */
export function resetSyncTiersClientForTests(): void {
  inFlightByUser.clear();
  lastFailedAtByUser.clear();
}
