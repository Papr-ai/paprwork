import { describe, expect, it } from "vitest";
import { replicaPushTimeoutMs } from "../../../src/gateway/services/tursoReplica/TursoReplicaService.js";

describe("replica push timeout scales with the backlog", () => {
  it("keeps 15s for a small or unknown backlog", () => {
    expect(replicaPushTimeoutMs(0)).toBe(15_000);
    expect(replicaPushTimeoutMs(Number.NaN)).toBe(15_000);
    expect(replicaPushTimeoutMs(-5)).toBe(15_000);
    expect(replicaPushTimeoutMs(500)).toBe(16_000);
  });

  it("gives a large backlog more time, up to 10 minutes", () => {
    expect(replicaPushTimeoutMs(50_000)).toBe(115_000);
    // 5.3M pending changes (the backlog that never drained at a fixed 15s)
    expect(replicaPushTimeoutMs(5_312_899)).toBe(600_000);
  });
});
