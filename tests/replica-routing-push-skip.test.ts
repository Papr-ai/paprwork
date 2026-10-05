import { beforeEach, describe, expect, it, vi } from "vitest";

const pushJob = vi.fn();

vi.mock("../src/gateway/services/TursoSyncBridge.js", () => ({
  ensureTursoSyncBridge: () => ({ pushJob }),
}));

vi.mock("../src/gateway/utils/tursoReplicaEnabled.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/gateway/utils/tursoReplicaEnabled.js")>();
  return {
    ...actual,
    // Rollout off: every source takes the legacy path (the dev-build default bug).
    shouldUseTursoReplicaForDb: () => false,
  };
});

const source = {
  appId: "app-1",
  alias: "pipeline",
  jobId: "db-abc",
  dbId: "db-abc",
  dbPath: "/tmp/does-not-matter.db",
} as const;

describe("pushLinkedSourceWithReplicaRouting — legacy skip is not a push", () => {
  beforeEach(() => {
    pushJob.mockReset();
  });

  it("marks a skipped legacy push as skipped (ok, but not pushed)", async () => {
    pushJob.mockResolvedValue({ status: "skipped", tables: [], reason: "replica_managed" });
    const { pushLinkedSourceWithReplicaRouting } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaRouting.js"
    );
    const result = await pushLinkedSourceWithReplicaRouting(source as never);
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("replica_managed");
  });

  it("does not mark a real legacy push as skipped", async () => {
    pushJob.mockResolvedValue({ status: "pushed", tables: ["*"] });
    const { pushLinkedSourceWithReplicaRouting } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaRouting.js"
    );
    const result = await pushLinkedSourceWithReplicaRouting(source as never);
    expect(result.ok).toBe(true);
    expect(result.skipped).toBeUndefined();
  });

  it("pushTursoSourcesWithReplicaRouting counts skipped as neither pushed nor failed", async () => {
    pushJob.mockResolvedValue({ status: "skipped", tables: [], reason: "all_tables_unchanged" });
    const { pushTursoSourcesWithReplicaRouting } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaRouting.js"
    );
    const summary = await pushTursoSourcesWithReplicaRouting({ sources: [source as never] });
    expect(summary.pushed).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.results[0]?.skipped).toBe(true);
  });
});
