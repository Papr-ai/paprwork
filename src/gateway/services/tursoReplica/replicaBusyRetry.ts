/**
 * The `busy_timeout` the replica engine does not have.
 *
 * Every better-sqlite3 path in this codebase waits out a contended file — the
 * mini-app read worker sets 3s, the CDC writer 5s. `@tursodatabase/sync` has no
 * equivalent knob (`connectTursoReplica` passes none), so a replica read that
 * lands while a push or migration holds the file fails on the first attempt and
 * the raw "database is locked" travels all the way to the mini-app UI.
 *
 * Waiting inside the caller's scheduler slot is intentional, and is what
 * `busy_timeout` does too: it blocks the connection rather than yielding it.
 * The budget stays well under REPLICA_OPERATION_TIMEOUT_MS so a contended read
 * still resolves inside the operation timeout instead of trading one error for
 * another.
 */

import { isReplicaBusyError } from "./tursoReplicaErrors.js";

/** ~2.4s total, in the same range as the better-sqlite3 read path's 3s. */
const BUSY_RETRY_DELAYS_MS = [150, 350, 700, 1200] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn`, retrying only while it fails with a lock error.
 *
 * Any other failure propagates on the first attempt — retrying a schema or
 * transport error would just delay the real report.
 */
export async function retryWhileReplicaBusy<T>(
  fn: () => Promise<T>,
  label: string,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= BUSY_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await sleep(BUSY_RETRY_DELAYS_MS[attempt - 1]);
    }
    try {
      return await fn();
    } catch (error) {
      if (!isReplicaBusyError(error)) {
        throw error;
      }
      lastError = error;
    }
  }

  // Out of budget: the holder is not transient. Report the lock rather than
  // masking it, so the caller's own recovery and the logs still see the truth.
  console.warn(
    `[TursoReplicaBusy] ${label} still locked after ` +
      `${BUSY_RETRY_DELAYS_MS.length + 1} attempts — giving up`,
  );
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** @internal test hook */
export const BUSY_RETRY_ATTEMPTS = BUSY_RETRY_DELAYS_MS.length + 1;
