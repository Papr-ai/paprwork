/**
 * Idempotency cache for writer POST /ops.
 */

import type { AppRepoOpsSuccessResponse } from "../../../core/types/appRepoWriterOps.js";

interface IdempotencyRecord {
  response: AppRepoOpsSuccessResponse;
  storedAtMs: number;
}

const cache = new Map<string, IdempotencyRecord>();
const TTL_MS = 24 * 60 * 60 * 1000;

function cacheKey(appId: string, idempotencyKey: string): string {
  return `${appId}:${idempotencyKey}`;
}

export function getIdempotentOpsResponse(
  appId: string,
  idempotencyKey: string,
): AppRepoOpsSuccessResponse | null {
  const hit = cache.get(cacheKey(appId, idempotencyKey));
  if (!hit) {
    return null;
  }
  if (Date.now() - hit.storedAtMs > TTL_MS) {
    cache.delete(cacheKey(appId, idempotencyKey));
    return null;
  }
  return hit.response;
}

export function storeIdempotentOpsResponse(
  appId: string,
  idempotencyKey: string,
  response: AppRepoOpsSuccessResponse,
): void {
  cache.set(cacheKey(appId, idempotencyKey), {
    response,
    storedAtMs: Date.now(),
  });
}

export function clearIdempotencyCacheForTests(): void {
  cache.clear();
}
