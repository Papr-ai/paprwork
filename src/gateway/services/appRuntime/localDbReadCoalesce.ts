/**
 * Collapse concurrent identical mini-app read requests into one in-flight trip.
 * Complements the TTL cache in localDbReadCache (completed reads).
 */

import * as crypto from "crypto";
import { timeReplicaReadPhase } from "../tursoReplica/replicaReadPhaseTrace.js";

const inflight = new Map<string, Promise<unknown>>();

export function buildLocalDbBatchCoalesceKey(
  appId: string,
  statements: unknown,
): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ appId, statements }))
    .digest("hex");
}

export function coalesceInFlightLocalDbRead<T>(
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const existing = inflight.get(key);
  if (existing) {
    return timeReplicaReadPhase("coalesceWaitMs", () => existing as Promise<T>);
  }
  const promise = run().finally(() => {
    if (inflight.get(key) === promise) {
      inflight.delete(key);
    }
  });
  inflight.set(key, promise);
  return promise;
}

/** Test-only: reset in-flight map. */
export function resetLocalDbReadCoalesceForTests(): void {
  inflight.clear();
}
