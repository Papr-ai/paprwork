/**
 * Short-TTL read cache for desktop mini-app /api/db/query (local preview).
 */

import * as crypto from "crypto";

const DEFAULT_TTL_MS = Number(process.env.LOCAL_DB_READ_CACHE_TTL_MS ?? 8_000);
const MAX_ENTRIES = 500;

interface CacheEntry {
  value: Record<string, unknown>;
  expiresAt: number;
  scope: string;
}

const cache = new Map<string, CacheEntry>();

export function buildLocalDbReadCacheKey(parts: {
  appId: string;
  sourceKey: string;
  sql: string;
  params?: unknown[];
}): string {
  const raw = JSON.stringify([
    parts.appId,
    parts.sourceKey,
    parts.sql,
    parts.params ?? [],
  ]);
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function getCachedLocalDbReadResult(
  key: string,
): Record<string, unknown> | undefined {
  const entry = cache.get(key);
  if (!entry) {
    return undefined;
  }
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

export function setCachedLocalDbReadResult(
  key: string,
  value: Record<string, unknown>,
  scope: string,
  ttlMs: number = DEFAULT_TTL_MS,
): void {
  if (cache.size >= MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, e] of cache) {
      if (now > e.expiresAt) {
        cache.delete(k);
      }
    }
    while (cache.size >= MAX_ENTRIES) {
      const first = cache.keys().next().value as string | undefined;
      if (first === undefined) {
        break;
      }
      cache.delete(first);
    }
  }
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
    scope,
  });
}

export function invalidateLocalDbReadCacheForApp(appId: string): void {
  for (const [key, entry] of cache) {
    if (entry.scope === appId) {
      cache.delete(key);
    }
  }
}

export function clearLocalDbReadCacheForTests(): void {
  cache.clear();
}
