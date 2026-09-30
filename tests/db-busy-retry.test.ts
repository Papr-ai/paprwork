/**
 * Lock contention policy for the mini-app SQLite worker pool (Issue: side-by-side
 * apps reporting multi-second waits and "database is locked").
 *
 * The defect these pin: the pool has two worker threads, each running one
 * synchronous better-sqlite3 call at a time, and the wait for a contended file
 * happened *inside* that call. One blocked request therefore held half the
 * gateway's SQLite capacity for the full timeout, and the error was handed
 * straight to the app with nothing having waited on its behalf.
 */

import { describe, it, expect, vi } from "vitest";
import {
  BUSY_RETRY_DELAYS_MS,
  MAX_TOTAL_BUSY_WAIT_MS,
  NON_RETRYABLE_BUSY_TIMEOUT_MS,
  PREVIOUS_IN_WORKER_BUDGET_MS,
  RETRYABLE_BUSY_TIMEOUT_MS,
  isRetryableWhenBusy,
  resolveWorkerBusyTimeoutMs,
  runWithBusyRetry,
} from "../src/gateway/services/appRuntime/dbBusyRetry.js";

function busyError(): Error & { code?: string } {
  const err = new Error("database is locked") as Error & { code?: string };
  err.code = "SQLITE_BUSY";
  return err;
}

describe("isRetryableWhenBusy", () => {
  it("retries reads, which have no side effects to repeat", () => {
    expect(isRetryableWhenBusy("query")).toBe(true);
    expect(isRetryableWhenBusy("schema")).toBe(true);
    expect(isRetryableWhenBusy("table-exists")).toBe(true);
  });

  it("retries a single write, which cannot have applied", () => {
    // SQLITE_BUSY is raised when the lock could not be acquired, so the
    // statement never ran. Re-running it is the same statement, not a second one.
    expect(isRetryableWhenBusy("write")).toBe(true);
  });

  it("retries write-batch, which db.transaction() rolls back whole", () => {
    expect(isRetryableWhenBusy("write-batch")).toBe(true);
  });

  it("never retries exec, which is not atomic", () => {
    // db.exec() runs several statements with no surrounding transaction, so a
    // lock on the third of five leaves the first two applied. Retrying would
    // apply them twice. This is the case the whole policy exists to protect.
    expect(isRetryableWhenBusy("exec")).toBe(false);
  });
});

describe("resolveWorkerBusyTimeoutMs", () => {
  it("gives retryable requests a short wait so the thread is released", () => {
    // The point of the fix: peak thread occupancy per attempt, not total
    // tolerance. A blocked read used to pin a worker for 3s.
    expect(resolveWorkerBusyTimeoutMs("query")).toBe(RETRYABLE_BUSY_TIMEOUT_MS);
    expect(RETRYABLE_BUSY_TIMEOUT_MS).toBeLessThanOrEqual(500);
  });

  it("keeps the whole wait in the worker for requests the pool cannot retry", () => {
    // The invariant that makes a short timeout safe: the wait lives wherever
    // the retry cannot. Shortening exec's timeout without a retry behind it
    // would make it strictly more likely to fail than before the fix.
    expect(resolveWorkerBusyTimeoutMs("exec")).toBe(
      NON_RETRYABLE_BUSY_TIMEOUT_MS,
    );
    expect(NON_RETRYABLE_BUSY_TIMEOUT_MS).toBeGreaterThan(
      RETRYABLE_BUSY_TIMEOUT_MS,
    );
  });

  it("derives both timeouts from the retry rule, not a second list", () => {
    const types = [
      "query",
      "write",
      "write-batch",
      "schema",
      "exec",
      "table-exists",
    ] as const;
    for (const type of types) {
      const expected = isRetryableWhenBusy(type)
        ? RETRYABLE_BUSY_TIMEOUT_MS
        : NON_RETRYABLE_BUSY_TIMEOUT_MS;
      expect(resolveWorkerBusyTimeoutMs(type)).toBe(expected);
    }
  });
});

describe("runWithBusyRetry", () => {
  it("passes an uncontended request straight through", async () => {
    const attempt = vi.fn().mockResolvedValue("rows");
    const onOutcome = vi.fn();

    await expect(runWithBusyRetry("query", attempt, onOutcome)).resolves.toBe(
      "rows",
    );
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledWith({
      busyAttempts: 0,
      recovered: false,
    });
  });

  it("recovers a read that was only contended", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(busyError())
      .mockResolvedValue("rows");

    await expect(runWithBusyRetry("query", attempt)).resolves.toBe("rows");
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("reports the retry's effect, not just its attempt count", async () => {
    // A count alone cannot distinguish a request this rescued from one it
    // merely delayed, which is what makes the fix measurable.
    const onOutcome = vi.fn();
    await runWithBusyRetry(
      "query",
      vi.fn().mockRejectedValueOnce(busyError()).mockResolvedValue("rows"),
      onOutcome,
    );
    expect(onOutcome).toHaveBeenCalledWith({
      busyAttempts: 1,
      recovered: true,
    });
  });

  it("classifies on SQLite's code, not only the message wording", async () => {
    const coded = new Error("some other phrasing") as Error & {
      code?: string;
    };
    coded.code = "SQLITE_BUSY";
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(coded)
      .mockResolvedValue("rows");

    await expect(runWithBusyRetry("query", attempt)).resolves.toBe("rows");
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("propagates anything that is not contention on the first attempt", async () => {
    // Retrying a missing table or a corrupt file only delays the real report.
    const attempt = vi.fn().mockRejectedValue(new Error("no such table: rows"));

    await expect(runWithBusyRetry("query", attempt)).rejects.toThrow(
      "no such table",
    );
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("does not retry exec even when the failure is a lock", async () => {
    const attempt = vi.fn().mockRejectedValue(busyError());

    await expect(runWithBusyRetry("exec", attempt)).rejects.toThrow(
      "database is locked",
    );
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("reports the lock as-is once the budget is spent", async () => {
    // Callers classify on this error, so the last thing to do is dress it up as
    // something else after waiting.
    const attempt = vi.fn().mockRejectedValue(busyError());

    await expect(runWithBusyRetry("query", attempt)).rejects.toThrow(
      "database is locked",
    );
    expect(attempt).toHaveBeenCalledTimes(BUSY_RETRY_DELAYS_MS.length + 1);
  });

  it("bounds total elapsed time, not just the attempt count", async () => {
    // Each attempt re-arms the pool's own 30s per-request timeout, so counting
    // attempts alone would let a worker that hangs — rather than reporting a
    // lock — stack that timeout once per attempt. Sleeping the whole ceiling is
    // the cheapest way to trip it, hence the long timeout on this one case.
    const slowBusy = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, MAX_TOTAL_BUSY_WAIT_MS));
      throw busyError();
    });

    await expect(runWithBusyRetry("query", slowBusy)).rejects.toThrow(
      "database is locked",
    );
    expect(slowBusy).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("is at least as tolerant as the wait it replaced", () => {
    // Moving the wait out of the worker must not trade head-of-line blocking
    // for a new failure. Reads had an explicit 3s; writes had no explicit
    // timeout and so inherited better-sqlite3's 5s default, which is the number
    // the budget has to beat. Shrinking the delays below this would make a
    // 4-second lock fail a write that used to survive it.
    const backoff = BUSY_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    const inSqlite =
      (BUSY_RETRY_DELAYS_MS.length + 1) * RETRYABLE_BUSY_TIMEOUT_MS;
    expect(backoff + inSqlite).toBeGreaterThanOrEqual(
      PREVIOUS_IN_WORKER_BUDGET_MS,
    );
  });

  it("keeps the gap between attempts short enough to notice a freed lock", () => {
    // A request only listens for the lock during its 250ms inside SQLite.
    // busy_timeout polled continuously and returned the instant a holder let
    // go, so any sleep between attempts is latency the old code did not have.
    // Exponential delays reached 1.5s here and left a read idle for over a
    // second after its lock had cleared.
    const longestGap = Math.max(...BUSY_RETRY_DELAYS_MS);
    expect(longestGap).toBeLessThanOrEqual(500);
  });

  it("leaves the ceiling clear of the planned budget", () => {
    // The ceiling exists for a worker that hangs instead of reporting a lock.
    // If it sat close to the budget, per-attempt overhead would clip the last
    // retry and quietly cost the tolerance asserted above.
    const planned =
      BUSY_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) +
      (BUSY_RETRY_DELAYS_MS.length + 1) * RETRYABLE_BUSY_TIMEOUT_MS;
    expect(MAX_TOTAL_BUSY_WAIT_MS).toBeGreaterThan(planned * 1.25);
  });
});
