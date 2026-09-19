import { afterEach, describe, expect, test, vi } from "vitest";

describe("workspace log genesis Plan A gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  test("batch orchestrator is a no-op when Plan A rollout is enabled", async () => {
    vi.stubEnv("PAPR_TURSO_REPLICA_SYNC", "replica-records");
    const tursoModule = await import(
      "../src/gateway/services/tursoLinkedSources.js"
    );
    const discover = vi
      .spyOn(tursoModule, "discoverTursoLinkedSources")
      .mockResolvedValue([
        {
          appId: "app-1",
          jobId: "job-1",
          dbPath: "/tmp/should-not-open.db",
          alias: "primary",
          dbId: "d-76fe7746",
        },
      ]);

    const { runWorkspaceLogGenesisCutoverForAllLinkedSources } = await import(
      "../src/gateway/services/syncV3/workspaceLogGenesisCutover.js"
    );
    const summary = await runWorkspaceLogGenesisCutoverForAllLinkedSources();
    expect(summary.attempted).toBe(0);
    expect(summary.completed).toBe(0);
    expect(summary.failed).toBe(0);
    expect(discover).not.toHaveBeenCalled();
  });

  test("replica-owned sources are skipped without snapshot when batch runs", async () => {
    vi.stubEnv("PAPR_TURSO_REPLICA_SYNC", "off");
    const registryModule = await import(
      "../src/gateway/services/DatabaseRegistryService.js"
    );
    vi.spyOn(registryModule, "getDatabaseRegistryService").mockReturnValue({
      getById: (id: string) =>
        id === "d-replica"
          ? { dbId: "d-replica", syncMode: "replica" as const, localPath: "/x.db" }
          : undefined,
      getByPath: () => undefined,
    } as ReturnType<typeof registryModule.getDatabaseRegistryService>);

    const tursoModule = await import(
      "../src/gateway/services/tursoLinkedSources.js"
    );
    vi.spyOn(tursoModule, "discoverTursoLinkedSources").mockResolvedValue([
      {
        appId: "app-1",
        jobId: "de1a89d8-0000-4000-8000-000000000001",
        dbPath: "/x.db",
        alias: "primary",
        dbId: "d-replica",
      },
    ]);

    const hashSpy = vi.spyOn(
      await import(
        "../src/gateway/services/syncV3/workspaceLogGenesisCutover.js"
      ),
      "computeDbSnapshotHash",
    );

    const { runWorkspaceLogGenesisCutoverForAllLinkedSources } = await import(
      "../src/gateway/services/syncV3/workspaceLogGenesisCutover.js"
    );
    const summary = await runWorkspaceLogGenesisCutoverForAllLinkedSources();
    expect(summary.attempted).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(hashSpy).not.toHaveBeenCalled();
  });
});
