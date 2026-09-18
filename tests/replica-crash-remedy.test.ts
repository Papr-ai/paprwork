/**
 * Crash-remedy selection for a sync-engine abort (Issue 116).
 *
 * The decision logic runs against the `inspect` seam so these stay independent of
 * better-sqlite3's ABI. Real-file coverage — building an actually malformed engine table
 * and watching the remedy change — lives in `scripts/test-replica-engine-table-guard.mjs`,
 * which runs under Electron for the same reason the sibling guard's tests do.
 *
 * The wiring assertions read source text because the alternative is standing up a real
 * child-process worker and crashing it on demand. What they pin is the part that is easy
 * to regress by reading the code in the wrong order: repair must not also reset the
 * sidecars, and a parked path must not be retried.
 */

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

import {
  chooseReplicaCrashRemedy,
  type ReplicaCrashRemedy,
} from "../src/gateway/services/tursoReplica/replicaCrashRemedy.js";
import type { ReplicaEngineTableDefect } from "../src/gateway/services/tursoReplica/replicaEngineTableGuard.js";

const MALFORMED: readonly ReplicaEngineTableDefect[] = [
  { table: "turso_cdc_version", reason: "missing_unique_index" },
];

function choose(
  defects: readonly ReplicaEngineTableDefect[] | (() => never),
  repairAlreadyAttempted = false,
): ReplicaCrashRemedy {
  return chooseReplicaCrashRemedy({
    localPath: "/tmp/data.db",
    repairAlreadyAttempted,
    inspect: typeof defects === "function" ? defects : () => defects,
  });
}

describe("chooseReplicaCrashRemedy", () => {
  it("keeps the sidecar reset when the engine tables are healthy", () => {
    // The standing policy is correct for a wedge in -wal/-info, which is the only
    // cause left once data.db has been cleared. Narrowing it would delete a recovery
    // that works today.
    expect(choose([])).toEqual({ kind: "reset_sidecars" });
  });

  it("repairs the engine tables when one is malformed", () => {
    const remedy = choose(MALFORMED);
    expect(remedy.kind).toBe("repair_engine_tables");
  });

  it("does not reset sidecars when it repairs", () => {
    // A reset preserves data.db by design, so pairing the two would throw away the
    // engine's WAL bookkeeping for a cause that does not live there. The remedy is a
    // union precisely so the caller cannot do both.
    const remedy = choose(MALFORMED);
    expect(remedy.kind).not.toBe("reset_sidecars");
  });

  it("parks once a malformed table survives a repair", () => {
    // Local state cannot be the cause of a table we just dropped. Every further
    // attempt re-aborts the worker, and each abort is a crash report.
    const remedy = choose(MALFORMED, true);
    expect(remedy.kind).toBe("park");
  });

  it("names the malformed table in both the repair and the park", () => {
    // The operator has to be able to tell which database is affected and why; a bare
    // "parked" with no shape is the log line that sent Issue 103 round twice.
    const repair = choose(MALFORMED);
    const parked = choose(MALFORMED, true);
    expect(repair.kind === "repair_engine_tables" && repair.defects).toContain(
      "turso_cdc_version",
    );
    expect(parked.kind === "park" && parked.defects).toContain(
      "turso_cdc_version",
    );
  });

  it("gives a park reason that points at the remote, not at local state", () => {
    const parked = choose(MALFORMED, true);
    expect(parked.kind).toBe("park");
    if (parked.kind !== "park") return;
    expect(parked.reason).toMatch(/remote/i);
  });

  it("keeps the default when the file cannot be read", () => {
    // A contended or missing file is not evidence either way. Reading a failed
    // inspection as "malformed" would drop engine tables on a healthy database.
    const remedy = choose(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });
    expect(remedy).toEqual({ kind: "reset_sidecars" });
  });

  it("treats the evidence as one-directional", () => {
    // Finding a defect proves the reset cannot help. Not finding one proves nothing
    // about the sidecars, so absence must not escalate. Asserted as a property over
    // both flags so a future short-circuit cannot satisfy it by accident.
    for (const repaired of [false, true]) {
      expect(choose([], repaired).kind).toBe("reset_sidecars");
    }
  });

  it("escalates only on the second sighting, never the first", () => {
    // Parking on sight would strand a database whose malformed table came from stale
    // local state — the curable case, and the common one.
    expect(choose(MALFORMED, false).kind).toBe("repair_engine_tables");
    expect(choose(MALFORMED, true).kind).toBe("park");
  });
});

/** Source with comments removed, so a rationale mentioning a symbol is not a match. */
function readStripped(relative: string): string {
  const source = fs.readFileSync(
    path.join(process.cwd(), relative),
    "utf8",
  );
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("TursoReplicaSyncWorkerClient wiring", () => {
  const client = readStripped(
    "src/gateway/services/tursoReplica/TursoReplicaSyncWorkerClient.ts",
  );

  it("chooses a remedy rather than always resetting sidecars", () => {
    expect(client).toContain("chooseReplicaCrashRemedy");
  });

  it("resets sidecars only on the reset_sidecars branch", () => {
    // If the reset ran before the chooser, the repair branch would be handed an
    // already-reset database and the whole distinction would collapse.
    const resets = client.match(/resetReplicaSidecars\(/g) ?? [];
    expect(resets).toHaveLength(1);
    const resetAt = client.indexOf("resetReplicaSidecars(");
    const branchAt = client.indexOf('case "reset_sidecars"');
    const repairAt = client.indexOf('case "repair_engine_tables"');
    expect(branchAt).toBeGreaterThan(-1);
    expect(resetAt).toBeGreaterThan(branchAt);
    expect(resetAt).toBeLessThan(repairAt);
  });

  it("does not retry a parked path", () => {
    // The retry is what turns one abort into two. A park means we already know the
    // next attempt aborts, so spending it is pure cost.
    const retryAt = client.indexOf("const retry =");
    expect(retryAt).toBeGreaterThan(-1);
    const retryExpr = client.slice(retryAt, client.indexOf(";", retryAt));
    expect(retryExpr).toContain("parkedPaths.has");
  });

  it("clears the repair marker on a healthy operation", () => {
    // The marker is what makes the second sighting meaningful. Left set, an unrelated
    // abort weeks later would park on its first strike.
    const healthyAt = client.indexOf("private noteHealthy(");
    expect(healthyAt).toBeGreaterThan(-1);
    const body = client.slice(healthyAt, client.indexOf("\n  }", healthyAt));
    expect(body).toContain("engineTableRepairs.delete");
    expect(body).toContain("crashStreaks.delete");
  });

  it("never lets a failed remedy replace the crash error", () => {
    // Both remedies touch the filesystem, so both can fail on a contended file.
    // `repairReplicaEngineTables` guards its open but not its DROP, so a SQLITE_BUSY
    // would propagate out of the caller's catch — skipping the retry and making
    // `isTursoSyncWorkerCrash` false for recovery downstream, over a transient lock.
    const applyAt = client.indexOf("private applyCrashRemedy(");
    expect(applyAt).toBeGreaterThan(-1);
    const body = client.slice(applyAt, client.indexOf("\n  }", applyAt));
    expect(body).toContain("try {");
    expect(body).toContain("catch (remedyError)");
  });

  it("counts the abort before attempting the remedy that can fail", () => {
    // The convergence argument depends on this order. A repair that throws leaves the
    // table malformed, so the retry aborts again — and only reaches the park if the
    // first attempt was already recorded. Counting afterwards would loop instead.
    const branchAt = client.indexOf('case "repair_engine_tables"');
    expect(branchAt).toBeGreaterThan(-1);
    const branch = client.slice(branchAt, client.indexOf('case "park"', branchAt));
    const noteAt = branch.indexOf("noteEngineCrash(");
    const markAt = branch.indexOf("engineTableRepairs.add(");
    const repairAt = branch.indexOf("repairReplicaEngineTables(");
    expect(noteAt).toBeGreaterThan(-1);
    expect(repairAt).toBeGreaterThan(-1);
    expect(noteAt).toBeLessThan(repairAt);
    expect(markAt).toBeLessThan(repairAt);
  });

  it("parks from the streak as well as from the chooser", () => {
    // The chooser only sees defects it can name. A path that aborts repeatedly with no
    // readable defect still has to stop somewhere, which is what the streak is for.
    const streakAt = client.indexOf("private noteEngineCrash(");
    expect(streakAt).toBeGreaterThan(-1);
    const body = client.slice(streakAt, client.indexOf("\n  }", streakAt));
    expect(body).toContain("MAX_CONSECUTIVE_PATH_CRASHES");
    expect(body).toContain("parkPath");
  });
});
