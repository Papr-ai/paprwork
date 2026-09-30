/**
 * During Publish / flushAppNow Turso push, mini-app reads must not hit the local
 * replica handle — push + sidecar reset + migration repair race interactive reads
 * and wedge the WAL. Route reads to Turso primary until quiesce ends.
 */

import * as path from "path";

const DEFAULT_QUIESCE_MS = 120_000;

function normalizeKey(localPath: string): string {
  return path.normalize(localPath);
}

const quiescedUntilMs = new Map<string, number>();

export function quiesceReplicaPathForPublish(
  localPath: string,
  durationMs: number = DEFAULT_QUIESCE_MS,
): void {
  const key = normalizeKey(localPath);
  quiescedUntilMs.set(key, Date.now() + durationMs);
}

export function releaseReplicaPublishQuiesce(localPath: string): void {
  quiescedUntilMs.delete(normalizeKey(localPath));
}

export function isReplicaPathPublishQuiesced(localPath: string): boolean {
  const until = quiescedUntilMs.get(normalizeKey(localPath));
  if (until === undefined) {
    return false;
  }
  if (Date.now() >= until) {
    quiescedUntilMs.delete(normalizeKey(localPath));
    return false;
  }
  return true;
}

export function resetReplicaPublishQuiesceForTests(): void {
  quiescedUntilMs.clear();
}
