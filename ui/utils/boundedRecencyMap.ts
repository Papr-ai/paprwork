/**
 * Insertion-ordered map with a size bound, for caches keyed by entity id.
 *
 * Deliberately dependency-free: the callers are storage helpers that run on
 * render paths, and the ordering rule below is subtle enough to be worth
 * testing on its own.
 */

/**
 * Keep the newest `max` entries, dropping the oldest.
 *
 * JavaScript preserves insertion order for string keys, so "oldest" means
 * "written longest ago" — which is what we want for a cache whose entries are
 * written when their entity is used.
 */
export function boundByRecency<T>(
  entries: Record<string, T>,
  max: number,
): Record<string, T> {
  const keys = Object.keys(entries);
  if (keys.length <= max) {
    return entries;
  }
  const kept: Record<string, T> = {};
  for (const key of keys.slice(keys.length - max)) {
    kept[key] = entries[key];
  }
  return kept;
}

/**
 * Add or replace `key`, positioning it as the newest entry.
 *
 * Re-assigning an existing key leaves it where it was, so an entity in
 * constant use would keep an old slot and be evicted as though it were stale.
 * Removing it first is what makes this recency rather than first-write order.
 */
export function touchNewest<T>(
  entries: Record<string, T>,
  key: string,
  value: T,
): Record<string, T> {
  const next = { ...entries };
  delete next[key];
  next[key] = value;
  return next;
}
