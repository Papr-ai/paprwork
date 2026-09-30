/**
 * stat-validated cache for small JSON files on cloud-sync hot paths.
 *
 * App/job link resolution runs once per app (hundreds) for every watcher event
 * and every git enqueue scan, and each pass re-read + re-parsed the same
 * data/jobs.json, metadata.json and data-sources.json files. A stat call is
 * orders of magnitude cheaper than read + JSON.parse, so results are reused
 * until mtime/size/inode change.
 */

import * as fs from "fs";

interface CacheEntry {
  signature: string;
  value: unknown;
}

/** Bounded so long-lived gateways with many apps cannot grow this without limit. */
const MAX_ENTRIES = 8_000;

const cache = new Map<string, CacheEntry>();

/** Per-key count of actual read + parse passes (cache misses). */
const deriveCounts = new Map<string, number>();

function fileSignature(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    return `${stat.mtimeNs}:${stat.size}:${stat.ino}`;
  } catch {
    return null;
  }
}

function store(key: string, entry: CacheEntry): void {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) {
      cache.delete(oldest.value);
    }
  }
  cache.set(key, entry);
}

/**
 * Derive a value from a file's contents, reusing the previous result while the
 * file is unchanged. `cacheKey` separates call sites that derive different
 * shapes from the same path. Returns `fallback` when missing or unparseable.
 *
 * Derived values are shared between callers — treat them as read-only.
 */
export function readDerivedFromFile<T>(
  filePath: string,
  cacheKey: string,
  derive: (raw: string) => T,
  fallback: T,
): T {
  const key = `${cacheKey}\u0000${filePath}`;
  const signature = fileSignature(filePath);
  if (signature === null) {
    cache.delete(key);
    return fallback;
  }

  const cached = cache.get(key);
  if (cached && cached.signature === signature) {
    return cached.value as T;
  }

  let value: T;
  try {
    value = derive(fs.readFileSync(filePath, "utf8"));
  } catch {
    value = fallback;
  }
  deriveCounts.set(key, (deriveCounts.get(key) ?? 0) + 1);
  store(key, { signature, value });
  return value;
}

/** How many times a path was actually read + parsed rather than served warm. */
export function getFileDeriveCount(filePath: string, cacheKey: string): number {
  return deriveCounts.get(`${cacheKey}\u0000${filePath}`) ?? 0;
}

/** Drop all cached file derivations (workspace switch, tests). */
export function clearJsonFileCache(): void {
  cache.clear();
  deriveCounts.clear();
}
