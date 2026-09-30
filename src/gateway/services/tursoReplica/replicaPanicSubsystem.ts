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
function readPanicLocationBasename(stderr: string | undefined): string | null {
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

  return file.split("/").pop() ?? file;
}

export function classifyReplicaPanicSubsystem(
  stderr: string | undefined,
): ReplicaPanicSubsystem | null {
  const basename = readPanicLocationBasename(stderr);
  if (!basename) {
    return null;
  }
  return SUBSYSTEM_BY_FILE.get(basename) ?? null;
}

/**
 * Modules that only panic about bytes already written to `data.db`.
 *
 * The mirror image of {@link SUBSYSTEM_BY_FILE}. `page_cache.rs` is named because its
 * state is process-local and a fresh process is the whole cure; these are named for the
 * opposite reason. `btree.rs` and `pager.rs` read and write the pages of `data.db`
 * itself, so an invariant broken there — a cursor whose `rowid` does not match the cell
 * it landed on, a page whose type byte is not a page type — describes the file, and no
 * amount of restarting or sidecar resetting changes a byte of it.
 *
 * This matters because the default remedy is actively counterproductive here.
 * `reset_sidecars` preserves `data.db` by design, so it cannot reach the cause; the
 * retry it licenses aborts on the same page; and the streak then spends up to six
 * process aborts — six crash reports — arriving at the park it could have reached on
 * the first one. Naming the file turns that into a single abort and a message that says
 * what actually cures it: re-seeding the replica from the remote.
 */
const DURABLE_STORAGE_PANIC_FILES: ReadonlySet<string> = new Set([
  "btree.rs",
  "pager.rs",
]);

/**
 * Whether the abort was raised while reading or writing the pages of `data.db`.
 *
 * Anchored on the same `panicked at <file>:<line>:<col>` location as
 * {@link classifyReplicaPanicSubsystem}, and for the same reason: a backtrace passes
 * through the btree on its way to plenty of unrelated panics, so matching anywhere in
 * stderr would read a sidecar wedge as file corruption and park a database that a reset
 * would have fixed.
 *
 * Returns false when no location was captured. Absence is not evidence of corruption —
 * the caller keeps the default remedy rather than parking on a truncated ring.
 *
 * True is not sufficient on its own, and the caller must not treat it as such. A
 * malformed engine table aborts here too — the engine seeks a unique index the table
 * lacks and `indexbtree_seek_internal` panics — and that case is cured by dropping one
 * table. So this answers "the abort came from the pages", not "nothing local can fix
 * it": `chooseReplicaCrashRemedy` inspects the engine tables before it parks on this.
 */
export function isReplicaPanicInDurableStorage(stderr: string | undefined): boolean {
  const basename = readPanicLocationBasename(stderr);
  if (!basename) {
    return false;
  }
  return DURABLE_STORAGE_PANIC_FILES.has(basename);
}
