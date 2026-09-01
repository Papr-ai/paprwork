/**
 * FdWatchdog — internal gateway telemetry for open file descriptor count.
 *
 * EBADF/EMFILE bash spawn failures happen when the OS cannot allocate more fds.
 * Users never see these numbers — recovery is handled by fdPressureRecovery.ts.
 */

import fs from "fs";

const DEFAULT_SAMPLE_INTERVAL_MS = 60_000;
const MIN_SAMPLE_INTERVAL_MS = 5_000;

/** Internal log threshold — triggers proactive watcher recovery. */
const DEFAULT_WARN_FD = 5_000;

/** Internal log threshold — triggers aggressive recovery. */
const DEFAULT_CRITICAL_FD = 8_000;

export type FdPressureLevel = "ok" | "warn" | "critical" | "unknown";

let lastSampleCount: number | null = null;
let lastSampleLevel: FdPressureLevel = "unknown";
let lastRecoveryAttemptMs = 0;
const RECOVERY_COOLDOWN_MS = 30_000;

function readWarnThreshold(): number {
  const raw = process.env.PAPRWORK_FD_WARN;
  if (!raw) return DEFAULT_WARN_FD;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WARN_FD;
}

function readCriticalThreshold(): number {
  const raw = process.env.PAPRWORK_FD_CRITICAL;
  if (!raw) return DEFAULT_CRITICAL_FD;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CRITICAL_FD;
}

function readSampleIntervalMs(): number {
  const raw = process.env.PAPRWORK_FD_SAMPLE_MS;
  if (!raw) return DEFAULT_SAMPLE_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_SAMPLE_INTERVAL_MS) {
    return DEFAULT_SAMPLE_INTERVAL_MS;
  }
  return parsed;
}

/** Count open fds via /dev/fd (macOS/Linux). Returns null when unavailable. */
export function getOpenFdCount(): number | null {
  try {
    return fs.readdirSync("/dev/fd").length;
  } catch {
    return null;
  }
}

export function classifyFdPressure(
  count: number | null,
  warnAt = readWarnThreshold(),
  criticalAt = readCriticalThreshold(),
): FdPressureLevel {
  if (count === null) return "unknown";
  if (count >= criticalAt) return "critical";
  if (count >= warnAt) return "warn";
  return "ok";
}

export function getFdPressureLevel(): FdPressureLevel {
  return lastSampleLevel;
}

export function getLastOpenFdCount(): number | null {
  return lastSampleCount;
}

export function refreshFdPressureSample(): void {
  const count = getOpenFdCount();
  lastSampleCount = count;
  lastSampleLevel = classifyFdPressure(count);
}

function scheduleRecoveryIfNeeded(level: FdPressureLevel, count: number): void {
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
        level === "critical"
          ? `watchdog critical (fds=${count})`
          : `watchdog warn (fds=${count})`,
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
    refreshFdPressureSample();
    const count = lastSampleCount;
    const level = lastSampleLevel;

    if (count === null) {
      return;
    }

    if (level === "critical") {
      console.warn(
        `[FdWatchdog] CRITICAL open fds=${count} (≥${criticalAt}) — running recovery`,
      );
      scheduleRecoveryIfNeeded(level, count);
      return;
    }

    if (level === "warn") {
      console.warn(`[FdWatchdog] Elevated open fds=${count} (≥${warnAt})`);
      scheduleRecoveryIfNeeded(level, count);
      return;
    }

    console.log(`[FdWatchdog] open fds=${count}`);
  };

  sample();

  console.log(
    `[FdWatchdog] Internal fd telemetry (every ${Math.round(intervalMs / 1000)}s, ` +
      `warn≥${warnAt}, critical≥${criticalAt})`,
  );

  setInterval(sample, intervalMs).unref();
}
