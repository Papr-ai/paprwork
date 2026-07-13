/**
 * Guardrails for cloud-hosted /api/db/* endpoints.
 *
 * Protects against runaway Turso read billing (the "1B reads" class of
 * incident) with three layers:
 *  1. Per-session sliding-window rate limiter (reads and writes separately)
 *  2. Short-TTL result micro-cache so polling apps and many concurrent
 *     viewers collapse to ~1 Turso read per TTL window
 *  3. Row cap on read queries (enforced in TursoDbAdapter via capReadSql)
 *
 * All state is in-process and best-effort — a fresh instance starts empty.
 */

import * as crypto from "crypto";

/* ------------------------------------------------------------------ */
/* 1. Rate limiter — sliding window per session key                    */
/* ------------------------------------------------------------------ */

const WINDOW_MS = 60_000;
const READ_LIMIT_PER_MIN = Number(process.env["CLOUD_DB_READ_LIMIT_PER_MIN"] ?? 120);
const WRITE_LIMIT_PER_MIN = Number(process.env["CLOUD_DB_WRITE_LIMIT_PER_MIN"] ?? 30);
const MAX_TRACKED_KEYS = 10_000;

interface WindowState {
  timestamps: number[];
}

const readWindows = new Map<string, WindowState>();
const writeWindows = new Map<string, WindowState>();

function sweep(map: Map<string, WindowState>, now: number): void {
  if (map.size < MAX_TRACKED_KEYS) return;
  for (const [key, state] of map) {
    if (
      state.timestamps.length === 0 ||
      now - state.timestamps[state.timestamps.length - 1] > WINDOW_MS
    ) {
      map.delete(key);
    }
  }
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds the caller should wait before retrying (when not allowed). */
  retryAfterSec: number;
}

/**
 * Check and consume rate-limit budget for a session key.
 * @param weight number of logical operations (batch requests pass statement count)
 */
export function checkDbRateLimit(
  key: string,
  kind: "read" | "write",
  weight = 1,
): RateLimitResult {
  const now = Date.now();
  const map = kind === "read" ? readWindows : writeWindows;
  const limit = kind === "read" ? READ_LIMIT_PER_MIN : WRITE_LIMIT_PER_MIN;

  sweep(map, now);

  let state = map.get(key);
  if (!state) {
    state = { timestamps: [] };
    map.set(key, state);
  }
  // Drop timestamps outside the window
  const cutoff = now - WINDOW_MS;
  while (state.timestamps.length > 0 && state.timestamps[0] < cutoff) {
    state.timestamps.shift();
  }

  if (state.timestamps.length + weight > limit) {
    const oldest = state.timestamps[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
    return { allowed: false, retryAfterSec };
  }

  for (let i = 0; i < weight; i++) state.timestamps.push(now);
  return { allowed: true, retryAfterSec: 0 };
}

/**
 * Stable session key for rate limiting: prefer authenticated identity,
 * fall back to share token, then IP.
 */
export function dbRateLimitKey(input: {
  sessionToken?: string;
  shareToken?: string;
  paprApiKey?: string;
  ip?: string;
}): string {
  const raw =
    input.sessionToken ?? input.paprApiKey ?? input.shareToken ?? input.ip ?? "anonymous";
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

/* ------------------------------------------------------------------ */
/* 2. Result micro-cache (reads only)                                  */
/* ------------------------------------------------------------------ */

const RESULT_TTL_MS = Number(process.env["CLOUD_DB_RESULT_CACHE_TTL_MS"] ?? 10_000);
const MAX_CACHE_ENTRIES = 500;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
  /** Invalidation scope: namespaceId|slug */
  scope: string;
}

const resultCache = new Map<string, CacheEntry>();

export function buildDbCacheKey(parts: {
  namespaceId: string;
  slug: string;
  appId: string;
  sourceId?: string;
  sql: string;
  params?: unknown[];
}): string {
  const raw = JSON.stringify([
    parts.namespaceId,
    parts.slug,
    parts.appId,
    parts.sourceId ?? "",
    parts.sql,
    parts.params ?? [],
  ]);
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function getCachedDbResult(key: string): unknown | undefined {
  const entry = resultCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    resultCache.delete(key);
    return undefined;
  }
  return entry.value;
}

export function setCachedDbResult(
  key: string,
  value: unknown,
  scope: { namespaceId: string; slug: string },
): void {
  if (resultCache.size >= MAX_CACHE_ENTRIES) {
    // Evict expired first, then oldest inserted
    const now = Date.now();
    for (const [k, e] of resultCache) {
      if (now > e.expiresAt) resultCache.delete(k);
    }
    while (resultCache.size >= MAX_CACHE_ENTRIES) {
      const firstKey = resultCache.keys().next().value as string | undefined;
      if (firstKey === undefined) break;
      resultCache.delete(firstKey);
    }
  }
  resultCache.set(key, {
    value,
    expiresAt: Date.now() + RESULT_TTL_MS,
    scope: `${scope.namespaceId}|${scope.slug}`,
  });
}

/** Invalidate all cached read results for an app after a write. */
export function invalidateDbCacheForApp(namespaceId: string, slug: string): void {
  const scope = `${namespaceId}|${slug}`;
  for (const [key, entry] of resultCache) {
    if (entry.scope === scope) resultCache.delete(key);
  }
}

/** Test hook. */
export function clearDbRequestGuardState(): void {
  readWindows.clear();
  writeWindows.clear();
  resultCache.clear();
}

/* ------------------------------------------------------------------ */
/* 3. Row cap for read queries                                         */
/* ------------------------------------------------------------------ */

export const MAX_READ_ROWS = Number(process.env["CLOUD_DB_MAX_READ_ROWS"] ?? 5000);

/**
 * Cap a read query's result size by wrapping it in an outer LIMIT.
 * Applied AFTER any table-name rewriting so it can't interfere with it.
 * Only wraps plain SELECT/WITH statements; anything else passes through
 * (assertReadOnlySql has already restricted the statement class).
 */
export function capReadSql(sql: string, maxRows: number = MAX_READ_ROWS): string {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  const head = trimmed.slice(0, 10).toLowerCase();
  if (!head.startsWith("select") && !head.startsWith("with")) {
    return trimmed;
  }
  return `SELECT * FROM (${trimmed}) LIMIT ${maxRows + 1}`;
}

/**
 * Truncate rows to the cap; returns whether truncation happened so the
 * response can flag it to the caller.
 */
export function capRows<T>(rows: T[], maxRows: number = MAX_READ_ROWS): {
  rows: T[];
  truncated: boolean;
} {
  if (rows.length <= maxRows) return { rows, truncated: false };
  return { rows: rows.slice(0, maxRows), truncated: true };
}
