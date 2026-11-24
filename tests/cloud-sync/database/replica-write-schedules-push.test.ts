import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A replica write that leaves rows pending must queue the debounced push itself.
 * The file watcher can miss it: the sync engine records writes in `-changes` /
 * `-info`, and registry DBs linked with a jobId used to resolve to the job's
 * scratch path, which the watcher skips (#473 verification on dev).
 */
describe("replica write → push scheduling", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  async function runWrite(pendingPush: boolean) {
    const schedule = vi.fn();
    vi.doMock("../../../src/gateway/services/tursoReplica/tursoReplicaPushScheduler.js", () => ({
      scheduleTursoReplicaPushForSyncKey: schedule,
    }));
    vi.doMock("../../../src/gateway/services/tursoReplica/TursoReplicaService.js", () => ({
      getTursoReplicaService: () => ({
        runWrite: async () => ({ changes: 1, lastInsertRowid: 1, pendingPush }),
      }),
    }));
    vi.doMock("../../../src/gateway/services/DatabaseRegistryService.js", async (orig) => ({
      ...(await orig<typeof import("../../../src/gateway/services/DatabaseRegistryService.js")>()),
      getDatabaseRegistryService: () => ({
        getById: () => ({ dbId: "db-57c03fda", tursoShortName: "d-57c03fda", isolation: "shared", syncMode: "replica" }),
        getByPath: () => undefined,
        updateReplicaPushState: async () => undefined,
      }),
    }));
    const routing = await import("../../../src/gateway/services/tursoReplica/tursoReplicaRouting.js");
    vi.spyOn(routing, "notifyReplicaDbChanged").mockImplementation(() => undefined);
    await routing.writeLinkedDbViaTursoReplica(
      {
        id: "briefs",
        type: "sqlite",
        alias: "briefs",
        dbId: "db-57c03fda",
        jobId: "38cc0dfc-a2b6-4399-8f3e-02c7b594ea01",
        dbPath: "/tmp/papr-test/data/databases/home-daily-briefs/data.db",
        tursoDatabase: "d-57c03fda",
        tables: [],
        linkedAt: "2026-01-01T00:00:00.000Z",
      } as never,
      "UPDATE brief_reviews SET note = ?",
      ["x"],
    );
    await new Promise((r) => setTimeout(r, 20));
    return schedule;
  }

  it("schedules a push keyed by dbId when the write is pending", async () => {
    const schedule = await runWrite(true);
    expect(schedule).toHaveBeenCalledWith("db-57c03fda", "normal", "api_write");
  });

  it("does not schedule when the write already reached the primary", async () => {
    const schedule = await runWrite(false);
    expect(schedule).not.toHaveBeenCalled();
  });
});
