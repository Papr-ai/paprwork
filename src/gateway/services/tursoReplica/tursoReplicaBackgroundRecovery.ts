/**
 * Background wedge recovery — keeps pull/repair off interactive read paths.
 */

import * as path from "path";
import { isTursoReplicaOnline } from "../../utils/tursoReplicaEnabled.js";
import { drainInboundReplicaCdcIfCaughtUp } from "./tursoReplicaInboundDrain.js";
import type { TursoReplicaService } from "./TursoReplicaService.js";

const DEGRADED_MS = 5 * 60_000;
const RECOVERY_COOLDOWN_MS = 2 * 60_000;
const FAILURE_WINDOW_MS = 5 * 60_000;
const MAX_FAILURES_BEFORE_DEGRADED = 2;

function normalizeKey(localPath: string): string {
  return path.normalize(localPath);
}

const recoveryInFlight = new Map<string, Promise<void>>();
const lastRecoveryScheduledMs = new Map<string, number>();
const degradedUntilMs = new Map<string, number>();
const failureWindows = new Map<string, { count: number; sinceMs: number }>();

export function isReplicaReadPathDegraded(localPath: string): boolean {
  const until = degradedUntilMs.get(normalizeKey(localPath));
  return until !== undefined && Date.now() < until;
}

export function noteReplicaReadPathFailure(localPath: string): void {
  const key = normalizeKey(localPath);
  const now = Date.now();
  let window = failureWindows.get(key);
  if (!window || now - window.sinceMs > FAILURE_WINDOW_MS) {
    window = { count: 0, sinceMs: now };
  }
  window.count += 1;
  failureWindows.set(key, window);
  if (window.count >= MAX_FAILURES_BEFORE_DEGRADED) {
    degradedUntilMs.set(key, now + DEGRADED_MS);
    console.warn(
      `[TursoReplicaService] Marking ${key} degraded for ${DEGRADED_MS / 1000}s after repeated read wedges`,
    );
  }
}

export function scheduleReplicaBackgroundWedgeRecovery(
  service: TursoReplicaService,
  localPath: string,
  tursoDatabase: string,
): void {
  const key = normalizeKey(localPath);
  if (recoveryInFlight.has(key)) {
    return;
  }
  const lastScheduled = lastRecoveryScheduledMs.get(key) ?? 0;
  if (Date.now() - lastScheduled < RECOVERY_COOLDOWN_MS) {
    return;
  }
  lastRecoveryScheduledMs.set(key, Date.now());

  const job = runBackgroundWedgeRecovery(service, localPath, tursoDatabase).finally(
    () => {
      recoveryInFlight.delete(key);
    },
  );
  recoveryInFlight.set(key, job);
  void job;
}

async function runBackgroundWedgeRecovery(
  service: TursoReplicaService,
  localPath: string,
  tursoDatabase: string,
): Promise<void> {
  console.warn(
    `[TursoReplicaService] Background wedge recovery started for ${tursoDatabase}`,
  );
  try {
    await service.recoverReadWedgeForBackground(localPath);
    if (!isTursoReplicaOnline()) {
      return;
    }
    const pulled = await service.pullForBackgroundRecovery(localPath, tursoDatabase);
    if (pulled) {
      await drainInboundReplicaCdcIfCaughtUp({
        source: {
          id: tursoDatabase,
          type: "sqlite",
          alias: tursoDatabase,
          dbPath: localPath,
          tables: [],
          linkedAt: new Date().toISOString(),
        },
        tursoDatabase,
      });
    }
    console.warn(
      `[TursoReplicaService] Background wedge recovery finished for ${tursoDatabase}`,
    );
  } catch (error) {
    console.warn(
      `[TursoReplicaService] Background wedge recovery failed for ${tursoDatabase}:`,
      (error as Error).message.slice(0, 160),
    );
  }
}

export function resetReplicaBackgroundRecoveryForTests(): void {
  recoveryInFlight.clear();
  lastRecoveryScheduledMs.clear();
  degradedUntilMs.clear();
  failureWindows.clear();
}
