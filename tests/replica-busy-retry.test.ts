/**
 * A lock is contention, not damage.
 *
 * The replica engine sets no `busy_timeout`, so a read that lands while a push
 * or a migration holds the file used to fail on its first attempt and hand the
 * raw "database is locked" to the mini-app UI. These tests pin the two rules
 * that fix makes: a lock is retried, and it is *only* retried — it must never
 * reach the wedge-recovery branch, which resets the sync sidecars.
 */

import { describe, it, expect, vi } from "vitest";
import {
  isReplicaBusyError,
  isSqliteBusyError,
} from "../src/gateway/services/tursoReplica/tursoReplicaErrors";
import {
  isReplicaReadTransportError,
  isReplicaSqlSchemaError,
} from "../src/gateway/services/tursoReplica/tursoReplicaCheckpointRecovery";
import {
  retryWhileReplicaBusy,
  BUSY_RETRY_ATTEMPTS,
} from "../src/gateway/services/tursoReplica/replicaBusyRetry";

describe("isReplicaBusyError", () => {
  it("matches the engine's bare lock message", () => {
    // `@tursodatabase/sync` reports this with no error code attached.
    expect(isReplicaBusyError(new Error("database is locked"))).toBe(true);
  });

  it("matches the table-level variant and the code spelling", () => {
    expect(isReplicaBusyError(new Error("database table is locked"))).toBe(
      true,
    );
    expect(isReplicaBusyError(new Error("SQLITE_BUSY: busy"))).toBe(true);
  });

  it("matches regardless of surrounding text or case", () => {
    expect(
      isReplicaBusyError(
        new Error("Turso replica query failed: Database Is Locked"),
      ),
    ).toBe(true);
  });

  it("accepts non-Error throwables", () => {
    expect(isReplicaBusyError("database is locked")).toBe(true);
  });

  it("does not match unrelated failures", () => {
    expect(isReplicaBusyError(new Error("no such table: briefs"))).toBe(false);
    expect(isReplicaBusyError(new Error("timed out after 30000ms"))).toBe(
      false,
    );
    expect(isReplicaBusyError(null)).toBe(false);
    expect(isReplicaBusyError(undefined)).toBe(false);
  });
});

describe("busy and wedge classifiers stay disjoint", () => {
  // This is the whole reason the lock check is a separate predicate rather than
  // another clause in `isReplicaReadTransportError`. That classifier's recovery
  // path calls `recoverReadWedge`, which closes the handle and resets sidecars.
  // Doing that because another operation briefly held the lock would be
  // destructive, so a lock must not be classified as a transport wedge.
  it("does not route a lock into sidecar-resetting wedge recovery", () => {
    expect(isReplicaReadTransportError("database is locked")).toBe(false);
  });

  it("still routes genuine wedges into recovery", () => {
    expect(
      isReplicaReadTransportError("unable to checkpoint synced portion of WAL"),
    ).toBe(true);
    expect(isReplicaReadTransportError("REPLICA_GEN_DRIFT")).toBe(true);
  });

  it("keeps a lock distinct from a SQL/schema error", () => {
    // A schema error is permanent; retrying it only delays the real report.
    expect(isReplicaSqlSchemaError("database is locked")).toBe(false);
    expect(isReplicaBusyError(new Error("no such column: brief_json"))).toBe(
      false,
    );
  });
});

describe("isSqliteBusyError", () => {
  it("matches the better-sqlite3 shape, which carries a code", () => {
    const err = Object.assign(new Error("SQLITE_BUSY"), {
      code: "SQLITE_BUSY",
    });
    expect(isSqliteBusyError(err)).toBe(true);
  });

  it("matches the engine shape, which carries no code", () => {
    // The regression: checking only `code` meant every "DB busy, defer" branch
    // silently never fired for replica-backed databases.
    expect(isSqliteBusyError(new Error("database is locked"))).toBe(true);
  });

  it("does not match unrelated coded errors", () => {
    const err = Object.assign(new Error("file is not a database"), {
      code: "SQLITE_NOTADB",
    });
    expect(isSqliteBusyError(err)).toBe(false);
  });
});

describe("retryWhileReplicaBusy", () => {
  it("returns the first result when nothing is locked", async () => {
    const fn = vi.fn().mockResolvedValue("rows");

    await expect(retryWhileReplicaBusy(fn, "read")).resolves.toBe("rows");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("waits out a transient lock and succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("database is locked"))
      .mockResolvedValue("rows");

    await expect(retryWhileReplicaBusy(fn, "read")).resolves.toBe("rows");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-lock failure", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("no such table: briefs"));

    await expect(retryWhileReplicaBusy(fn, "read")).rejects.toThrow(
      "no such table: briefs",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("rethrows the lock once the budget is spent, rather than masking it", async () => {
    // Giving up must surface the real error: the caller's own recovery and the
    // logs both depend on seeing the lock.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fn = vi.fn().mockRejectedValue(new Error("database is locked"));

    await expect(retryWhileReplicaBusy(fn, "read briefs")).rejects.toThrow(
      "database is locked",
    );
    expect(fn).toHaveBeenCalledTimes(BUSY_RETRY_ATTEMPTS);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  }, 10_000);
});
