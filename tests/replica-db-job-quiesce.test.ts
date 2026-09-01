import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

describe("replicaDbJobQuiesce", () => {
  useIsolatedPaprWorkspace();
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("closes TursoReplicaService handle for replica-managed registry paths", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";
    process.env.CLOUD_SYNC_ENABLED = "true";

    const close = vi.fn(async () => undefined);
    vi.doMock("../src/gateway/services/tursoReplica/TursoReplicaService.js", () => ({
      getTursoReplicaService: () => ({ close }),
    }));

    const registryMod = await import(
      "../src/gateway/services/DatabaseRegistryService.js"
    );
    const dbPath = "/tmp/Papr/data/databases/outreach/data.db";
    const registry = registryMod.getDatabaseRegistryService();
    vi.spyOn(registry, "getByPath").mockImplementation((p: string) => {
      if (p === dbPath) {
        return {
          dbId: "db-outreach",
          localPath: dbPath,
          syncMode: "replica",
          tursoShortName: "d-outreach",
          isolation: "shared",
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
      }
      return undefined;
    });

    const { releaseReplicaHandleForJob } = await import(
      "../src/gateway/services/tursoReplica/replicaDbJobQuiesce.js"
    );

    const released = await releaseReplicaHandleForJob(dbPath);
    expect(released).toBe(true);
    expect(close).toHaveBeenCalledWith(dbPath);
  });

  it("no-ops for non-replica paths", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "off";

    const close = vi.fn(async () => undefined);
    vi.doMock("../src/gateway/services/tursoReplica/TursoReplicaService.js", () => ({
      getTursoReplicaService: () => ({ close }),
    }));

    const { releaseReplicaHandleForJob } = await import(
      "../src/gateway/services/tursoReplica/replicaDbJobQuiesce.js"
    );

    const released = await releaseReplicaHandleForJob("/tmp/job/data/data.db");
    expect(released).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });
});
