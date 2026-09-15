/**
 * Lock contention policy for the mini-app SQLite worker pool.
 *
 * The pool has two worker threads for every mini-app in the gateway, and each
 * runs one better-sqlite3 call at a time. better-sqlite3 is synchronous, so a
 * call waiting out `busy_timeout` pins its whole thread for the entire wait —
 * one blocked request removes half the gateway's SQLite capacity, and a second
 * removes all of it. That is head-of-line blocking: two apps open side by side
 * report multi-second waits that track the blocker's timeout rather than their
 * own query cost, and whoever exhausts the wait first hands "database is
 * locked" to the app, which renders it as empty or errored data.
 *
 * So the wait moves out of the worker: a short timeout inside SQLite releases
 * the thread quickly, and the pool retries with backoff. The app-visible
 * tolerance is roughly preserved while peak thread occupancy per attempt drops
 * from seconds to a quarter-second, which is what lets the other app through.
 *
 * The rule below decides which requests may be retried, and the worker derives
 * its timeout from that same rule, because **the wait has to live wherever the
 * retry cannot**. Two separate lists would eventually disagree and leave a
 * non-retryable request with a wait too short to survive on its own.
 */

import { isSqliteBusyError } from "../tursoReplica/tursoReplicaErrors.js";

export type DbWorkerRequestType =
  | "query"
  | "write"
  | "write-batch"
  | "schema"
  | "exec"
  | "table-exists";

/**
 * Whether re-running this request after a lock error is safe.
 *
 * `SQLITE_BUSY` is raised when a lock could not be acquired, so a single
 * statement never applied and a `write-batch` — which runs inside
 * `db.transaction()` — is rolled back whole. Both can be re-run as they were.
 *
 * `exec` cannot. It runs several statements with no surrounding transaction, so
 * a lock taken on the third of five leaves the first two applied; re-running
 * would apply them a second time. It waits inside the worker instead.
 */
export function isRetryableWhenBusy(type: DbWorkerRequestType): boolean {
  return type !== "exec";
}

/** Long enough to absorb ordinary contention, short enough to free the thread. */
export const RETRYABLE_BUSY_TIMEOUT_MS = 250;

/** The pool cannot retry these, so the whole wait has to happen in the worker. */
export const NON_RETRYABLE_BUSY_TIMEOUT_MS = 5_000;

export function resolveWorkerBusyTimeoutMs(
  type: DbWorkerRequestType,
): number {
  return isRetryableWhenBusy(type)
    ? RETRYABLE_BUSY_TIMEOUT_MS
    : NON_RETRYABLE_BUSY_TIMEOUT_MS;
}

/**
 * Backoff that grows and then holds at 400ms: ~3s across 9 retries, which with
 * the worker's own 250ms wait per attempt puts the budget near 5.5s.
 *
 * Two constraints fix this schedule, and they pull in opposite directions.
 *
 * The total has to be at least as generous as the longest wait any request used
 * to get, or moving the wait out of the worker would trade head-of-line
 * blocking for a new class of failure. Reads had an explicit 3s; writes had no
 * explicit timeout and so inherited better-sqlite3's 5s default.
 *
 * The gap between attempts has to stay small, because a request is only
 * listening for the lock during its 250ms inside SQLite. `busy_timeout` polls
 * continuously and so returned the instant a holder let go; a retry loop only
 * notices at its next attempt, and anything sleeping between attempts adds
 * latency the old code did not have. Purely exponential delays reached 1.5s and
 * left a read idle for over a second after its lock had already cleared.
 */
export const BUSY_RETRY_DELAYS_MS = [
  100, 200, 300, 400, 400, 400, 400, 400, 400,
] as const;

/** The longest wait any request had before the retry moved out of the worker. */
export const PREVIOUS_IN_WORKER_BUDGET_MS = 5_000;

/**
 * Absolute ceiling on a single request's retries.
 *
 * Each attempt is a fresh `execute()` and so re-arms the pool's own per-request
 * timeout. Counting attempts alone would let a pathological case — a worker
 * that hangs rather than returning a lock error — stack that 30s timeout once
 * per attempt, so elapsed time gates starting another one.
 *
 * Set clear of the planned budget above so it only fires on that pathology. If
 * it sat close to the budget, a few milliseconds of overhead per attempt would
 * silently clip the last retry and cost the tolerance this is sized to keep.
 */
export const MAX_TOTAL_BUSY_WAIT_MS = 8_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BusyRetryOutcome {
  /** Attempts that ended in a lock error. 0 for the uncontended path. */
  busyAttempts: number;
  /**
   * Whether the request went on to succeed. Reported separately from the
   * attempt count so the log records what the retry *achieved*: a count alone
   * cannot distinguish a request this rescued from one it merely delayed.
   */
  recovered: boolean;
}

/**
 * Run `attempt`, retrying only while it fails with a lock error.
 *
 * Anything else propagates from the first attempt: retrying a missing table or
 * a corrupt file only delays the real report. Between attempts the worker is
 * already free — the pool resolves and drains before the failure surfaces here
 * — so the backoff is served by other apps' queries rather than by an idle
 * thread.
 */
export async function runWithBusyRetry<T>(
  type: DbWorkerRequestType,
  attempt: () => Promise<T>,
  onOutcome?: (outcome: BusyRetryOutcome) => void,
): Promise<T> {
  if (!isRetryableWhenBusy(type)) {
    return attempt();
  }

  const startedAt = Date.now();
  let busyAttempts = 0;
  let lastError: unknown;

  for (let i = 0; i <= BUSY_RETRY_DELAYS_MS.length; i++) {
    if (i > 0) {
      const delay = BUSY_RETRY_DELAYS_MS[i - 1];
      if (Date.now() - startedAt + delay > MAX_TOTAL_BUSY_WAIT_MS) {
        break;
      }
      await sleep(delay);
    }

    try {
      const result = await attempt();
      onOutcome?.({ busyAttempts, recovered: busyAttempts > 0 });
      return result;
    } catch (error) {
      if (!isSqliteBusyError(error)) {
        throw error;
      }
      busyAttempts += 1;
      lastError = error;
    }
  }

  onOutcome?.({ busyAttempts, recovered: false });

  // Out of budget: the holder is not transient. Report the lock as-is rather
  // than dressing it up, so callers that classify on it still see the truth.
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
