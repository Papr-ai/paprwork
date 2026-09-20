/**
 * Which part of the engine aborted, read from the panic's own file location.
 *
 * Location rather than message text. The messages inside one module vary and grow — the
 * shipped binary carries "mismatched evictable count state", "clock hand is null during
 * eviction" and "walpage evicted between scan and prepare" all in `page_cache.rs` — so a
 * message list drifts behind the engine, while the file name covers every invariant in
 * that module including ones not written yet.
 *
 * Only one subsystem is named, because only one changes the remedy. `PageCache` is an
 * in-memory structure: its counters, clock hand and entry map live in the process and are
 * encoded nowhere on disk. A panic there says the cache's accounting disagrees with
 * itself, and says nothing about `data.db` or the sidecars — so a fresh process, which
 * starts with a fresh cache, is the whole cure.
 *
 * No imports: this is read from the sync worker as well as the gateway.
 */

/** A module whose panics are known to be process-local. */
export type ReplicaPanicSubsystem = "page_cache";

const SUBSYSTEM_BY_FILE: ReadonlyMap<string, ReplicaPanicSubsystem> = new Map([
  ["page_cache.rs", "page_cache" as const],
]);

/**
 * Anchored on the `panicked at <file>:<line>:<col>` line, never on the whole text.
 *
 * A backtrace walks through the page cache on its way to plenty of unrelated panics, so
 * searching all of stderr for the file name would read an on-disk btree defect — the one
 * case that genuinely needs the file repaired — as process-local, skip the repair, and
 * abort until the streak parks it. The location line names where the panic *was raised*.
 *
 * Returns null when no location line was captured. Absence is not evidence: the caller
 * keeps its default rather than treating a truncated ring as a clean bill of health.
 */
export function classifyReplicaPanicSubsystem(
  stderr: string | undefined,
): ReplicaPanicSubsystem | null {
  if (!stderr) {
    return null;
  }

  // Last match, not first: with `panic = abort` the first panic ends the process, but a
  // panic raised while handling one appends a second location, and that one is the abort.
  let file: string | null = null;
  const pattern = /panicked at\s+(\S+?):\d+:\d+/g;
  for (let match = pattern.exec(stderr); match; match = pattern.exec(stderr)) {
    file = match[1] ?? null;
  }
  if (!file) {
    return null;
  }

  const basename = file.split("/").pop() ?? file;
  return SUBSYSTEM_BY_FILE.get(basename) ?? null;
}
