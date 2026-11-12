import { describe, expect, it } from "vitest";
import { replicaPullTimeoutMs } from "../../../src/gateway/services/tursoReplica/TursoReplicaService.js";

describe("replica pull timeout scales with the remote database size", () => {
  it("keeps 15s for a small or unknown remote", () => {
    expect(replicaPullTimeoutMs(0)).toBe(15_000);
    expect(replicaPullTimeoutMs(Number.NaN)).toBe(15_000);
    expect(replicaPullTimeoutMs(-1)).toBe(15_000);
    // 1 MB database: +1s
    expect(replicaPullTimeoutMs(1_000_000)).toBe(16_000);
  });

  it("gives a large remote enough time to download, up to 10 minutes", () => {
    // 192 MB (46,934 × 4 KB pages) — the replica that never caught up at a fixed 15s
    expect(replicaPullTimeoutMs(46_934 * 4_096)).toBe(15_000 + 192_242);
    expect(replicaPullTimeoutMs(5_000_000_000)).toBe(600_000);
  });
});
