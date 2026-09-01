/**
 * Automatic recovery when file-descriptor pressure is detected.
 *
 * Internal only — never surfaces fd counts or "quit and relaunch" to users.
 */

import {
  classifyFdPressure,
  getOpenFdCount,
  getFdPressureLevel,
  refreshFdPressureSample,
} from "./FdWatchdog.js";

let recoveryInFlight: Promise<boolean> | null = null;

function readCriticalThreshold(): number {
  const raw = process.env.PAPRWORK_FD_CRITICAL;
  if (!raw) return 8_000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8_000;
}

/**
 * Release watcher-backed fds and re-open them. Returns true when pressure dropped
 * below the critical threshold (or was never critical).
 */
export async function attemptFdPressureRecovery(reason: string): Promise<boolean> {
  if (recoveryInFlight) {
    return recoveryInFlight;
  }

  recoveryInFlight = (async () => {
    const before = getOpenFdCount();
    let releasedWatchers = 0;

    try {
      const { getAppService } = await import("./AppService.js");
      releasedWatchers = await getAppService().releaseWatchersForFdRecovery();
    } catch (error) {
      console.warn(
        "[FdRecovery] AppService watcher release failed:",
        error instanceof Error ? error.message : error,
      );
    }

    try {
      const { stopCodeIndexing } = await import("./CodeIndexingService.js");
      await stopCodeIndexing();
    } catch {
      // Code indexing may not be running.
    }

    await new Promise((resolve) => setTimeout(resolve, 150));

    const after = getOpenFdCount();
    refreshFdPressureSample();
    const criticalAt = readCriticalThreshold();
    const recovered =
      after === null || after < criticalAt || getFdPressureLevel() !== "critical";

    console.warn(
      `[FdRecovery] ${reason}: open fds ${before ?? "?"} → ${after ?? "?"}, ` +
        `released ${releasedWatchers} app watcher(s), recovered=${recovered}`,
    );

    if (releasedWatchers > 0) {
      try {
        const { getAppService } = await import("./AppService.js");
        await getAppService().reestablishAppWatchers();
      } catch (error) {
        console.warn(
          "[FdRecovery] Re-establish app watchers failed:",
          error instanceof Error ? error.message : error,
        );
      }
    }

    return recovered;
  })().finally(() => {
    recoveryInFlight = null;
  });

  return recoveryInFlight;
}

export function shouldAttemptFdRecovery(): boolean {
  return classifyFdPressure(getOpenFdCount()) !== "ok";
}
