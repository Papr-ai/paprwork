/**
 * Automatic recovery when file-descriptor pressure is detected.
 *
 * Internal only — never surfaces fd counts or "quit and relaunch" to users.
 */

import {
  classifyFdPressure,
  getFdPressureLevel,
  refreshFdPressureSample,
  sampleOpenFds,
} from "./FdWatchdog.js";

let recoveryInFlight: Promise<boolean> | null = null;

function readCriticalThreshold(): number {
  const raw = process.env.PAPRWORK_FD_CRITICAL;
  if (!raw) return 9_500;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 9_500;
}

/**
 * Drop fd-heavy handles (code indexer, Turso replica connections) and re-arm
 * app change routing. Returns true when the HIGHEST fd number dropped below
 * the critical threshold (or was never critical).
 *
 * Since the tree-watcher migration, watchers hold a constant handful of fds;
 * the remaining pressure sources are SQLite/Turso handles and sockets.
 */
export async function attemptFdPressureRecovery(reason: string): Promise<boolean> {
  if (recoveryInFlight) {
    return recoveryInFlight;
  }

  recoveryInFlight = (async () => {
    const before = sampleOpenFds();
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

    try {
      const { drainTursoReplicaConnections } = await import(
        "./tursoReplica/TursoReplicaService.js"
      );
      await drainTursoReplicaConnections("fd pressure recovery");
    } catch (error) {
      console.warn(
        "[FdRecovery] Turso replica drain failed:",
        error instanceof Error ? error.message : error,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 150));

    const after = refreshFdPressureSample();
    const criticalAt = readCriticalThreshold();
    // Spawn breaks on the highest fd NUMBER, so that is what "recovered" means.
    const recovered =
      after === null || after.highest < criticalAt || getFdPressureLevel() !== "critical";

    const fmt = (s: ReturnType<typeof sampleOpenFds>) =>
      s ? `open=${s.count} highest=${s.highest}` : "?";
    console.warn(
      `[FdRecovery] ${reason}: ${fmt(before)} → ${fmt(after)}, ` +
        `released ${releasedWatchers} app watcher(s), recovered=${recovered}`,
    );

    // Re-establish app change routing. With the tree watcher this is one OS
    // handle, so it never lands back in the high-fd range that broke spawn.
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
  return classifyFdPressure(sampleOpenFds()?.highest ?? null) !== "ok";
}
