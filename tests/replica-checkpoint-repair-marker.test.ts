import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Issue: a checkpoint/WAL error re-bootstrapped a healthy replica.
 *
 * `repairReplicaSidecarsOnCheckpointError` wrote a bootstrap-pending marker unconditionally,
 * so a Data Room holding 27k rows was snapshotted, re-downloaded and replayed because its
 * sidecars drifted — serving "Replica bootstrap backoff active" 503s throughout. These tests
 * pin the narrowing: the marker follows the rows, not the mere existence of the file.
 */

const calls: string[] = [];

const countUserRows = vi.fn<(p: string) => number>(() => 0);
const writeBootstrapPendingMarker = vi.fn((_p: string, _r: string) => {
  calls.push("marker");
});
const removeTursoReplicaSidecarsOnly = vi.fn((_p: string) => {
  calls.push("delete");
});

vi.mock(
  "../src/gateway/services/tursoReplica/tursoReplicaBootstrapMarker.js",
  () => ({
    countUserRows: (p: string) => {
      calls.push("count");
      return countUserRows(p);
    },
    writeBootstrapPendingMarker,
  }),
);

vi.mock("../src/gateway/services/tursoReplica/tursoReplicaFileGuard.js", () => ({
  removeTursoReplicaSidecarsOnly,
}));

const { repairReplicaSidecarsOnCheckpointError, resetReplicaSidecars } =
  await import(
    "../src/gateway/services/tursoReplica/tursoReplicaSidecarWedge.js"
  );

let dir: string;
let dbPath: string;

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-ckpt-"));
  dbPath = path.join(dir, "data.db");
  fs.writeFileSync(dbPath, "");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("repairReplicaSidecarsOnCheckpointError — marker follows the rows", () => {
  it("skips the marker when the replica holds rows", () => {
    countUserRows.mockReturnValue(27_658);

    expect(repairReplicaSidecarsOnCheckpointError(dbPath)).toBe(true);

    // The reported failure: a populated Data Room forced onto the bootstrap path, which
    // snapshots + re-downloads + replays and 503s every read until it finishes.
    expect(writeBootstrapPendingMarker).not.toHaveBeenCalled();
    expect(removeTursoReplicaSidecarsOnly).toHaveBeenCalledWith(dbPath);
  });

  it("writes the marker when the replica is empty", () => {
    countUserRows.mockReturnValue(0);

    expect(repairReplicaSidecarsOnCheckpointError(dbPath)).toBe(true);

    // The silent-empty-replica case the marker exists for: openSpec decides bootstrapIfEmpty
    // from the file merely existing, so without the marker this is never seeded.
    expect(writeBootstrapPendingMarker).toHaveBeenCalledWith(
      dbPath,
      "checkpoint_error_repair",
    );
  });

  it("writes the marker when the replica is unreadable, not treating -1 as populated", () => {
    countUserRows.mockReturnValue(-1);

    repairReplicaSidecarsOnCheckpointError(dbPath);

    // countUserRows documents -1 as "unknown, never empty" — and it is equally not evidence
    // of "populated". Unknown must take the conservative branch, so a `rows !== 0` test
    // (rather than `rows <= 0`) would silently skip seeding a replica that cannot be read.
    expect(writeBootstrapPendingMarker).toHaveBeenCalledWith(
      dbPath,
      "checkpoint_error_repair",
    );
  });

  it("counts before deleting the sidecars", () => {
    countUserRows.mockReturnValue(5);

    repairReplicaSidecarsOnCheckpointError(dbPath);

    // Rows that live only in `-wal` are real rows. Counting after the delete would read a
    // populated replica as 0 and write the marker this change exists to avoid.
    expect(calls.indexOf("count")).toBeGreaterThan(-1);
    expect(calls.indexOf("delete")).toBeGreaterThan(-1);
    expect(calls.indexOf("count")).toBeLessThan(calls.indexOf("delete"));
  });

  it("writes the marker before deleting the sidecars", () => {
    countUserRows.mockReturnValue(0);

    repairReplicaSidecarsOnCheckpointError(dbPath);

    // A crash between the two costs one redundant pull in this order; reversed, it leaves a
    // sidecar-less empty replica with no marker — the silent-empty-replica bug itself.
    expect(calls.indexOf("marker")).toBeLessThan(calls.indexOf("delete"));
  });

  it("does nothing for a path that does not exist", () => {
    expect(
      repairReplicaSidecarsOnCheckpointError(path.join(dir, "absent.db")),
    ).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("resetReplicaSidecars — the two conditions diverge", () => {
  it("skips the marker for sidecar drift on a populated replica", () => {
    countUserRows.mockReturnValue(15_980);

    resetReplicaSidecars(dbPath, "sidecar_drift");

    // The papr-books case: drift in the sidecars says nothing about data.db, so re-downloading
    // 15,980 rows buys nothing — and the bootstrap it forces runs replayBootstrapSnapshot,
    // which is the Issue 117 corruption mechanism.
    expect(writeBootstrapPendingMarker).not.toHaveBeenCalled();
    expect(removeTursoReplicaSidecarsOnly).toHaveBeenCalledWith(dbPath);
  });

  it("writes the marker for sidecar drift on an empty replica", () => {
    countUserRows.mockReturnValue(0);

    resetReplicaSidecars(dbPath, "sidecar_drift");

    expect(writeBootstrapPendingMarker).toHaveBeenCalledWith(
      dbPath,
      "pre_sync_sidecar_reset",
    );
  });

  it("keeps the marker unconditional after an engine panic, even when populated", () => {
    countUserRows.mockReturnValue(15_980);

    resetReplicaSidecars(dbPath, "engine_panic");

    // An abort is evidence about the process and possibly about data.db itself, so row count
    // is not a reason to trust the file. A redundant re-bootstrap beats serving a damaged one.
    expect(writeBootstrapPendingMarker).toHaveBeenCalledWith(
      dbPath,
      "engine_panic_sidecar_reset",
    );
  });

  it("does not gate the panic path on a row count at all", () => {
    countUserRows.mockReturnValue(-1);

    resetReplicaSidecars(dbPath, "engine_panic");

    // Not merely "writes the marker anyway": the panic path must not consult the count, or a
    // later edit could reintroduce the gate by flipping one comparison.
    expect(calls).toEqual(["marker", "delete"]);
  });

  it("gives the two conditions distinct reasons", () => {
    countUserRows.mockReturnValue(0);
    resetReplicaSidecars(dbPath, "sidecar_drift");
    resetReplicaSidecars(dbPath, "engine_panic");

    // Both previously wrote `pre_sync_sidecar_reset`, so a marker on disk could not say which
    // condition produced it — which is exactly what made the five live markers unreadable.
    const reasons = writeBootstrapPendingMarker.mock.calls.map((c) => c[1]);
    expect(new Set(reasons).size).toBe(2);
  });
});
