/**
 * FdWatchdog — internal gateway telemetry for file-descriptor pressure.
 *
 * What actually breaks spawning on macOS is NOT the number of open fds and NOT
 * `ulimit -n`. libuv spawns children with `posix_spawn`, and macOS libc rejects
 * any fd *number* ≥ OPEN_MAX (10240, compile-time) in
 * `posix_spawn_file_actions_adddup2/addclose` with EBADF. Node allocates pipe
 * fds for the child's stdio at the lowest free slot, so once the fd table is
 * packed up to ~10230 every spawn with piped stdio fails — bash, jobs, esbuild,
 * Playwright, venv creation — while `ulimit -n` still reports a million.
 *
 * So the watchdog samples both the count (for logs) and the HIGHEST open fd
 * number (for pressure), and classifies pressure on the highest number.
 * Recovery is handled by fdPressureRecovery.ts.
 */

import fs from "fs";

const DEFAULT_SAMPLE_INTERVAL_MS = 15_000;
const MIN_SAMPLE_INTERVAL_MS = 5_000;

/**
 * macOS libc OPEN_MAX. Linux/Windows have no such posix_spawn ceiling, but the
 * same threshold is a sane "something is leaking" signal everywhere.
 */
export const DARWIN_SPAWN_FD_CEILING = 10_240;

/** Internal log threshold — triggers proactive watcher recovery. */
const DEFAULT_WARN_FD = 8_000;

/** Internal log threshold — triggers aggressive recovery. */
const DEFAULT_CRITICAL_FD = 9_500;

export type FdPressureLevel = "ok" | "warn" | "critical" | "unknown";

export interface FdSample {
  /** Number of open fds. */
  count: number;
  /** Highest open fd number — the value that gates posix_spawn on macOS. */
  highest: number;
}

let lastSample: FdSample | null = null;
let lastSampleLevel: FdPressureLevel = "unknown";
let lastRecoveryAttemptMs = 0;
const RECOVERY_COOLDOWN_MS = 30_000;

function readIntEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function readWarnThreshold(): number {
  return readIntEnv("PAPRWORK_FD_WARN", DEFAULT_WARN_FD);
}

function readCriticalThreshold(): number {
  return readIntEnv("PAPRWORK_FD_CRITICAL", DEFAULT_CRITICAL_FD);
}

function readSampleIntervalMs(): number {
  return readIntEnv("PAPRWORK_FD_SAMPLE_MS", DEFAULT_SAMPLE_INTERVAL_MS, MIN_SAMPLE_INTERVAL_MS);
}

/** Sample /dev/fd (macOS/Linux). Returns null when unavailable (Windows). */
export function sampleOpenFds(): FdSample | null {
  try {
    const entries = fs.readdirSync("/dev/fd");
    let highest = -1;
    for (const entry of entries) {
      const n = Number.parseInt(entry, 10);
      if (Number.isFinite(n) && n > highest) highest = n;
    }
    return { count: entries.length, highest };
  } catch {
    return null;
  }
}

/** Count open fds via /dev/fd (macOS/Linux). Returns null when unavailable. */
export function getOpenFdCount(): number | null {
  return sampleOpenFds()?.count ?? null;
}

/** Highest open fd number. Returns null when unavailable. */
export function getHighestOpenFd(): number | null {
  return sampleOpenFds()?.highest ?? null;
}

/**
 * Classify pressure. Pass the HIGHEST fd number (not count) — spawn breaks on
 * the number. Accepts a count for backwards compatibility with callers/tests
 * that only have that; a packed table makes the two equal anyway.
 */
export function classifyFdPressure(
  highestOrCount: number | null,
  warnAt = readWarnThreshold(),
  criticalAt = readCriticalThreshold(),
): FdPressureLevel {
  if (highestOrCount === null) return "unknown";
  if (highestOrCount >= criticalAt) return "critical";
  if (highestOrCount >= warnAt) return "warn";
  return "ok";
}

/**
 * True when a spawn with piped stdio would fail right now on macOS. Cheap
 * enough to call immediately before a spawn to attach a precise diagnostic.
 */
export function isSpawnFdCeilingReached(sample = sampleOpenFds()): boolean {
  if (!sample || process.platform !== "darwin") return false;
  // Node allocates up to 3 pipe pairs (6 fds) below the ceiling.
  return sample.highest >= DARWIN_SPAWN_FD_CEILING - 8;
}

export function getFdPressureLevel(): FdPressureLevel {
  return lastSampleLevel;
}

export function getLastOpenFdCount(): number | null {
  return lastSample?.count ?? null;
}

export function getLastFdSample(): FdSample | null {
  return lastSample;
}

export function refreshFdPressureSample(): FdSample | null {
  lastSample = sampleOpenFds();
  lastSampleLevel = classifyFdPressure(lastSample?.highest ?? null);
  return lastSample;
}

function scheduleRecoveryIfNeeded(level: FdPressureLevel, sample: FdSample): void {
  if (level === "ok" || level === "unknown") {
    return;
  }

  const now = Date.now();
  if (now - lastRecoveryAttemptMs < RECOVERY_COOLDOWN_MS) {
    return;
  }
  lastRecoveryAttemptMs = now;

  void import("./fdPressureRecovery.js")
    .then(({ attemptFdPressureRecovery }) =>
      attemptFdPressureRecovery(
        `watchdog ${level} (highest fd=${sample.highest}, open=${sample.count})`,
      ),
    )
    .catch((error) => {
      console.warn(
        "[FdWatchdog] Recovery scheduling failed:",
        error instanceof Error ? error.message : error,
      );
    });
}

export function startFdWatchdog(): void {
  const warnAt = readWarnThreshold();
  const criticalAt = readCriticalThreshold();
  const intervalMs = readSampleIntervalMs();

  const sample = (): void => {
    const s = refreshFdPressureSample();
    const level = lastSampleLevel;
    if (!s) {
      return;
    }

    if (level === "critical") {
      console.warn(
        `[FdWatchdog] CRITICAL highest fd=${s.highest} open=${s.count} (≥${criticalAt}, spawn ceiling ${DARWIN_SPAWN_FD_CEILING}) — running recovery`,
      );
      scheduleRecoveryIfNeeded(level, s);
      return;
    }

    if (level === "warn") {
      console.warn(
        `[FdWatchdog] Elevated highest fd=${s.highest} open=${s.count} (≥${warnAt})`,
      );
      scheduleRecoveryIfNeeded(level, s);
      return;
    }

    console.log(`[FdWatchdog] open fds=${s.count} highest=${s.highest}`);
  };

  sample();

  console.log(
    `[FdWatchdog] Internal fd telemetry (every ${Math.round(intervalMs / 1000)}s, ` +
      `warn≥${warnAt}, critical≥${criticalAt}, gated on highest fd number)`,
  );

  setInterval(sample, intervalMs).unref();
}
