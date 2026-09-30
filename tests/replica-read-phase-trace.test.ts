import { describe, expect, it } from "vitest";
import {
  finishReplicaReadTrace,
  getRecentReplicaReadPhaseTraces,
  markReplicaReadPhase,
  resetReplicaReadPhaseTracesForTests,
  withReplicaReadTrace,
} from "../src/gateway/services/tursoReplica/replicaReadPhaseTrace.js";

describe("replicaReadPhaseTrace", () => {
  it("records phases and unaccounted time inside trace", async () => {
    resetReplicaReadPhaseTracesForTests();
    await withReplicaReadTrace("test", { appId: "a" }, async () => {
      markReplicaReadPhase("openSpecMs", 12);
      markReplicaReadPhase("ipcQueryMs", 8);
      await new Promise((r) => setTimeout(r, 30));
      finishReplicaReadTrace({ backend: "turso-replica" });
    });
    const traces = getRecentReplicaReadPhaseTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0]?.phases.openSpecMs).toBe(12);
    expect(traces[0]?.phases.ipcQueryMs).toBe(8);
    expect(traces[0]?.totalMs).toBeGreaterThanOrEqual(30);
    expect(traces[0]?.totalMs).toBeGreaterThan(
      (traces[0]?.phases.openSpecMs ?? 0) + (traces[0]?.phases.ipcQueryMs ?? 0),
    );
  });
});
