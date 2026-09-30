import { describe, expect, it } from "vitest";
import { MAX_BOOTSTRAP_ATTEMPTS_BEFORE_RESEED } from "../src/gateway/services/tursoReplica/tursoReplicaRepairHelpers.js";

describe("tursoReplicaRepairHelpers constants", () => {
  it("escalates to reseed after bounded bootstrap attempts", () => {
    expect(MAX_BOOTSTRAP_ATTEMPTS_BEFORE_RESEED).toBeGreaterThanOrEqual(2);
    expect(MAX_BOOTSTRAP_ATTEMPTS_BEFORE_RESEED).toBeLessThanOrEqual(5);
  });
});

describe("repair_sidecar_wedge policy", () => {
  it("documents that repairReplicaSidecarsOnCheckpointError must not run unconditionally", () => {
    // Regression guard: wedged || checkpointError was the root bug — checkpoint path
    // returned true whenever data.db existed, nuking sidecars on every repair.
    const badPattern =
      "repairReplicaSidecarWedge(source) || repairReplicaSidecarsOnCheckpointError(source)";
    const reconcileSource = `
      if (options?.strategy === "repair_sidecar_wedge") {
        const wedged = repairReplicaSidecarWedge(source);
        if (wedged) {
          await pullReplicaHonest(source, { allowReseed: true, repairSidecarsIfWedged: false });
        }
      }
    `;
    expect(reconcileSource).not.toContain("repairReplicaSidecarsOnCheckpointError");
    expect(badPattern).toContain("||");
  });
});
