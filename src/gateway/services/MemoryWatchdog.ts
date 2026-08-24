/**
 * MemoryWatchdog — records how the gateway heap grows, and captures a heap
 * snapshot while there is still room to serialize one.
 *
 * The gateway has been dying of V8 OOM (`node::OOMErrorHandler` → abort), which
 * kills in-flight agent turns. Two constraints shaped this:
 *
 *   - There is no headroom to add. Electron clamps `--max-old-space-size` to
 *     4096 MB, which is already the default, so the ceiling cannot be raised.
 *   - `--heapsnapshot-near-heap-limit` writes a 0-byte file in this Electron
 *     build; V8 cannot serialize once it is already out of memory.
 *
 * So we sample on an interval and snapshot at a fraction of the limit, where
 * `v8.writeHeapSnapshot()` still has the memory it needs to complete.
 */

import fs from "fs";
import path from "path";
import v8 from "v8";
import { getPaprworkBaseDir } from "../../core/utils/paprWorkspace.js";

const DEFAULT_SAMPLE_INTERVAL_MS = 60_000;
const MIN_SAMPLE_INTERVAL_MS = 1_000;

/**
 * Fraction of the heap limit that triggers a snapshot. Deliberately well below
 * the limit: a snapshot serializes to roughly 3x the live heap, so capturing at
 * 35% of 4GB already writes ~4GB. Steady state is far under this, so crossing it
 * is itself evidence of a leak in progress.
 */
const DEFAULT_SNAPSHOT_AT_PCT = 0.35;

/**
 * One snapshot at a time. At ~3x the heap these run to several GB, and this has
 * to stay safe on a 16GB machine with finite disk, so the previous capture is
 * removed before a new one is written rather than accumulating.
 */
const MAX_RETAINED_SNAPSHOTS = 1;

/** Refuse to snapshot without this much free space per byte of live heap. */
const REQUIRED_FREE_DISK_RATIO = 6;

/** Escalating thresholds, so we capture both onset and near-death growth. */
const SNAPSHOT_STEP_PCT = 0.15;

interface Sample {
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  rss: number;
}

const MB = 1024 * 1024;
const toMb = (bytes: number): number => Math.round(bytes / MB);

function readSample(): Sample {
  const usage = process.memoryUsage();
  return {
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    rss: usage.rss,
  };
}

function resolveSnapshotDir(): string {
  return path.join(getPaprworkBaseDir(), "diagnostics");
}

/**
 * Make room for `incoming` more snapshots. Called before writing so peak disk
 * usage stays at one snapshot rather than old plus new.
 */
function pruneSnapshots(dir: string, incoming: number): void {
  try {
    const existing = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".heapsnapshot"))
      .map((name) => {
        const full = path.join(dir, name);
        return { full, mtimeMs: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const keep = Math.max(0, MAX_RETAINED_SNAPSHOTS - incoming);
    for (const stale of existing.slice(keep)) {
      fs.unlinkSync(stale.full);
    }
  } catch (error) {
    console.warn(
      "[MemoryWatchdog] Could not prune old snapshots:",
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * A snapshot that fills the disk would be worse than the leak we are chasing,
 * so confirm the space exists first.
 */
function hasRoomForSnapshot(dir: string, heapUsed: number): boolean {
  try {
    const stats = fs.statfsSync(dir);
    const freeBytes = stats.bavail * stats.bsize;
    const needed = heapUsed * REQUIRED_FREE_DISK_RATIO;

    if (freeBytes < needed) {
      console.warn(
        `[MemoryWatchdog] Skipping snapshot — needs ~${toMb(needed)}MB free, ` +
          `only ${toMb(freeBytes)}MB available on ${dir}`,
      );
      return false;
    }
    return true;
  } catch {
    // If free space cannot be determined, prefer capturing the diagnostic.
    return true;
  }
}

function captureSnapshot(heapUsed: number, limit: number): void {
  const dir = resolveSnapshotDir();

  try {
    fs.mkdirSync(dir, { recursive: true });
    pruneSnapshots(dir, 1);

    if (!hasRoomForSnapshot(dir, heapUsed)) return;

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(
      dir,
      `gateway-${toMb(heapUsed)}MB-${stamp}.heapsnapshot`,
    );

    console.warn(
      `[MemoryWatchdog] Heap at ${toMb(heapUsed)}MB of ${toMb(limit)}MB — ` +
        `writing snapshot (this pauses the gateway briefly)...`,
    );

    v8.writeHeapSnapshot(target);

    console.warn(
      `[MemoryWatchdog] Snapshot written: ${target} ` +
        `(${toMb(fs.statSync(target).size)}MB). Open it in Chrome DevTools → Memory.`,
    );
  } catch (error) {
    // Diagnostics must never take down the process they are observing.
    console.error(
      "[MemoryWatchdog] Snapshot failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

function readPctOverride(): number {
  const raw = process.env.PAPRWORK_HEAP_SNAPSHOT_PCT;
  if (!raw) return DEFAULT_SNAPSHOT_AT_PCT;

  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    console.warn(
      `[MemoryWatchdog] Ignoring PAPRWORK_HEAP_SNAPSHOT_PCT="${raw}" ` +
        `(expected a fraction between 0 and 1)`,
    );
    return DEFAULT_SNAPSHOT_AT_PCT;
  }
  return parsed;
}

/** Tightened when a leak needs finer resolution than one sample per minute. */
function readSampleIntervalMs(): number {
  const raw = process.env.PAPRWORK_HEAP_SAMPLE_MS;
  if (!raw) return DEFAULT_SAMPLE_INTERVAL_MS;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_SAMPLE_INTERVAL_MS) {
    console.warn(
      `[MemoryWatchdog] Ignoring PAPRWORK_HEAP_SAMPLE_MS="${raw}" ` +
        `(minimum ${MIN_SAMPLE_INTERVAL_MS}ms)`,
    );
    return DEFAULT_SAMPLE_INTERVAL_MS;
  }
  return parsed;
}

export function startMemoryWatchdog(): void {
  const heapLimit = v8.getHeapStatistics().heap_size_limit;
  const snapshotsEnabled = process.env.PAPRWORK_HEAP_SNAPSHOT_DISABLED !== "1";
  let nextSnapshotPct = readPctOverride();

  const intervalMs = readSampleIntervalMs();
  const perSampleLabel = `${Math.round(intervalMs / 1000)}s`;

  const baseline = readSample();
  let previous = baseline;

  console.log(
    `[MemoryWatchdog] Watching heap (limit ${toMb(heapLimit)}MB, ` +
      `sampling every ${perSampleLabel}, ` +
      `snapshot at ${Math.round(nextSnapshotPct * 100)}%` +
      `${snapshotsEnabled ? "" : ", snapshots disabled"})`,
  );

  const timer = setInterval(() => {
    const current = readSample();
    const pctUsed = current.heapUsed / heapLimit;

    // External and arrayBuffers are reported alongside heapUsed because they
    // distinguish a JS-object leak from retained buffers, which point at very
    // different culprits.
    console.log(
      `[MemoryWatchdog] heap ${toMb(current.heapUsed)}MB ` +
        `(${Math.round(pctUsed * 100)}% of ${toMb(heapLimit)}MB) ` +
        `Δ${toMb(current.heapUsed - previous.heapUsed) >= 0 ? "+" : ""}` +
        `${toMb(current.heapUsed - previous.heapUsed)}MB/${perSampleLabel} ` +
        `since-start +${toMb(current.heapUsed - baseline.heapUsed)}MB | ` +
        `external ${toMb(current.external)}MB ` +
        `arrayBuffers ${toMb(current.arrayBuffers)}MB rss ${toMb(current.rss)}MB`,
    );

    previous = current;

    if (snapshotsEnabled && pctUsed >= nextSnapshotPct) {
      captureSnapshot(current.heapUsed, heapLimit);
      // Raise the bar so a heap that keeps climbing yields a second, later
      // capture instead of one snapshot per sample.
      nextSnapshotPct = Math.min(pctUsed + SNAPSHOT_STEP_PCT, 0.95);
    }
  }, intervalMs);

  // Never hold the process open just to report on it.
  timer.unref();
}
