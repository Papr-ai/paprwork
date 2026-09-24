/**
 * Remote app updates that arrived but could not be applied yet (local rows
 * still pushing, conflicts, login). The commit cursor is NOT advanced for
 * these, so Get updates / remote-code-status still see the update. A short
 * retry loop applies it automatically once the blocker clears.
 */

import { broadcast } from "../../websocket/index.js";

export interface PendingAppUpdate {
  appId: string;
  commitSha: string;
  reason: string;
  conflictFiles?: string[];
  since: string;
  attempts: number;
}

const RETRY_MS = Number(process.env.PAPR_APP_UPDATE_RETRY_MS ?? 30_000);
const MAX_ATTEMPTS = 20;

const pending = new Map<string, PendingAppUpdate>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function getPendingAppUpdate(appId: string): PendingAppUpdate | null {
  return pending.get(appId) ?? null;
}

function notify(appId: string): void {
  broadcast({
    type: "app-update:pending",
    data: { appId, pending: pending.get(appId) ?? null },
  });
}

export function clearPendingAppUpdate(appId: string): void {
  const timer = timers.get(appId);
  if (timer) clearTimeout(timer);
  timers.delete(appId);
  if (pending.delete(appId)) notify(appId);
}

/**
 * Record a waiting update and schedule a retry. Conflicts are not retried —
 * they need a user decision; everything else (pending push, login) is.
 */
export function markPendingAppUpdate(
  input: { appId: string; commitSha: string; reason: string; conflictFiles?: string[] },
  retry: () => Promise<boolean>,
): void {
  const prior = pending.get(input.appId);
  const attempts = prior && prior.commitSha === input.commitSha ? prior.attempts + 1 : 1;
  pending.set(input.appId, {
    ...input,
    since: prior?.since ?? new Date().toISOString(),
    attempts,
  });
  notify(input.appId);

  const existing = timers.get(input.appId);
  if (existing) clearTimeout(existing);
  timers.delete(input.appId);

  if ((input.conflictFiles?.length ?? 0) > 0 || attempts >= MAX_ATTEMPTS) {
    return;
  }
  const timer = setTimeout(() => {
    timers.delete(input.appId);
    void retry().catch(() => {});
  }, RETRY_MS);
  timer.unref?.();
  timers.set(input.appId, timer);
}

export function resetPendingAppUpdatesForTests(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  pending.clear();
}
