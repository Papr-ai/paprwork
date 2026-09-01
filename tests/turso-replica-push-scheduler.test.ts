import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

describe("tursoReplicaPushScheduler routing", () => {
  useIsolatedPaprWorkspace();
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("scheduleTursoPushForJob delegates to replica scheduler for registry DBs", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";
    process.env.CLOUD_SYNC_ENABLED = "true";

    const replicaSchedule = vi.fn();
    vi.doMock(
      "../src/gateway/services/tursoReplica/tursoReplicaPushScheduler.js",
      () => ({
        scheduleTursoReplicaPushForSyncKey: replicaSchedule,
      }),
    );

    const routing = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaRouting.js"
    );
    const registryMod = await import(
      "../src/gateway/services/DatabaseRegistryService.js"
    );
    const bridgeMod = await import("../src/gateway/services/TursoSyncBridge.js");

    vi.spyOn(registryMod, "getDatabaseRegistryService").mockReturnValue({
      getById: (dbId: string) =>
        dbId === "db-test"
          ? {
              dbId: "db-test",
              localPath: "/tmp/data/databases/billing/data.db",
              tursoShortName: "d-test0001",
              isolation: "shared",
              status: "active",
              syncMode: "replica",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            }
          : undefined,
      getByPath: () => undefined,
    } as ReturnType<typeof registryMod.getDatabaseRegistryService>);

    vi.spyOn(bridgeMod, "ensureTursoSyncBridge").mockReturnValue({
      enabled: true,
      getAppsRootDir: () => "/tmp/apps",
    } as ReturnType<typeof bridgeMod.ensureTursoSyncBridge>);

    vi.spyOn(routing, "shouldSuppressLegacyTursoPush").mockReturnValue(true);

    const { scheduleTursoPushForJob } = await import(
      "../src/gateway/services/tursoPushScheduler.js"
    );

    scheduleTursoPushForJob("db-test", "normal", "watcher");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(replicaSchedule).toHaveBeenCalledWith("db-test", "normal", "watcher");
  });

  it("evaluateDbChange schedules replica push for Plan A registry DBs", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";
    process.env.CLOUD_SYNC_ENABLED = "true";

    const replicaSchedule = vi.fn();
    vi.doMock(
      "../src/gateway/services/tursoReplica/tursoReplicaPushScheduler.js",
      () => ({
        scheduleTursoReplicaPushForSyncKey: replicaSchedule,
      }),
    );

    const routing = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaRouting.js"
    );
    vi.spyOn(routing, "shouldSuppressLegacyTursoPush").mockReturnValue(true);

    const coordinatorMod = await import(
      "../src/gateway/services/cloudSync/SyncCoordinator.js"
    );
    vi.spyOn(coordinatorMod, "getSyncCoordinator").mockReturnValue(null);

    const { getPaprRoot } = await import("../src/core/utils/paprRoot.js");
    const dbPath = `${getPaprRoot()}/data/databases/todos/data.db`;

    const { evaluateDbChangeForTests } = await import(
      "../src/gateway/services/TursoLinkedDbWatcher.js"
    );

    evaluateDbChangeForTests({
      syncKey: "db-test",
      dbId: "db-test",
      dbPath,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(replicaSchedule).toHaveBeenCalledWith("db-test", "normal", "watcher");
  });

  it("scheduleTursoReplicaPushForSyncKey skips watcher push in manual upload mode", async () => {
    vi.doUnmock("../src/gateway/services/tursoReplica/tursoReplicaPushScheduler.js");
    vi.resetModules();

    process.env.PAPR_TURSO_REPLICA_SYNC = "force";
    process.env.CLOUD_SYNC_ENABLED = "true";

    const { resetTursoReplicaPushSchedulerForTests, scheduleTursoReplicaPushForSyncKey } =
      await import(
        "../src/gateway/services/tursoReplica/tursoReplicaPushScheduler.js"
      );
    resetTursoReplicaPushSchedulerForTests();

    const uploadMode = await import("../src/gateway/services/cloudUploadMode.js");
    vi.spyOn(uploadMode, "shouldAutoUploadReplicaSyncKey").mockReturnValue(false);

    const bridgeMod = await import("../src/gateway/services/TursoSyncBridge.js");
    vi.spyOn(bridgeMod, "ensureTursoSyncBridge").mockReturnValue({
      enabled: true,
      getAppsRootDir: () => "/tmp/papr/apps",
    } as ReturnType<typeof bridgeMod.ensureTursoSyncBridge>);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    scheduleTursoReplicaPushForSyncKey("db-test", "normal", "watcher");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("skipped (manual upload mode)"),
    );

    logSpy.mockRestore();
    resetTursoReplicaPushSchedulerForTests();
  });
});
