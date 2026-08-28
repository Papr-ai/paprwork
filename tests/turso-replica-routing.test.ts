import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDataSource } from "../src/gateway/services/appDataSources.js";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

describe("tursoReplicaRouting", () => {
  useIsolatedPaprWorkspace();
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("requires registry record for replica routing (excludes job scratch)", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";
    process.env.CLOUD_SYNC_ENABLED = "true";

    const { shouldUseTursoReplicaForSource } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaRouting.js"
    );

    const scratchSource: AppDataSource = {
      id: "job:abc",
      type: "sqlite",
      jobId: "abc-123",
      alias: "scratch",
      dbPath: "/tmp/Jobs/abc/data/data.db",
      tables: [],
      linkedAt: new Date().toISOString(),
    };

    expect(shouldUseTursoReplicaForSource(scratchSource)).toBe(false);
  });

  it("suppresses legacy push only for registry DBs on replica rollout", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";
    process.env.CLOUD_SYNC_ENABLED = "true";

    const routing = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaRouting.js"
    );
    const registryMod = await import(
      "../src/gateway/services/DatabaseRegistryService.js"
    );

    const registry = registryMod.getDatabaseRegistryService();
    vi.spyOn(registry, "getById").mockImplementation((dbId: string) => {
      if (dbId === "db-test") {
        return {
          dbId: "db-test",
          localPath: "/tmp/data/databases/billing/data.db",
          tursoShortName: "d-test0001",
          isolation: "shared",
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
      }
      return undefined;
    });
    vi.spyOn(registry, "getByPath").mockReturnValue(undefined);

    expect(
      routing.shouldSuppressLegacyTursoPush({
        syncKey: "job-scratch-id",
        dbPath: "/tmp/Jobs/x/data/data.db",
      }),
    ).toBe(false);

    expect(
      routing.shouldSuppressLegacyTursoPush({
        syncKey: "db-test",
        dbId: "db-test",
        dbPath: "/tmp/data/databases/billing/data.db",
      }),
    ).toBe(true);
  });

  it("notifyReplicaDbChanged publishes jobs:db-changed for dbId", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";
    process.env.CLOUD_SYNC_ENABLED = "true";

    const events: unknown[] = [];
    const hubMod = await import("../src/gateway/services/JobEventHub.js");
    vi.spyOn(hubMod.getJobEventHub(), "publish").mockImplementation((event) => {
      events.push(event);
    });

    const cloudMod = await import(
      "../src/gateway/services/cloudSync/notifyCloudDbChanged.js"
    );
    vi.spyOn(cloudMod, "notifyCloudDbChanged").mockResolvedValue(undefined);

    const { notifyReplicaDbChanged } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaRouting.js"
    );

    const source: AppDataSource = {
      id: "db-test",
      type: "sqlite",
      dbId: "db-test",
      alias: "replica-test",
      dbPath: "/tmp/data/databases/replica-test/data.db",
      tables: [],
      linkedAt: new Date().toISOString(),
    };

    notifyReplicaDbChanged(source);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "jobs:db-changed",
      data: { dbId: "db-test", tables: [] },
    });
    expect(cloudMod.notifyCloudDbChanged).toHaveBeenCalledWith({
      dbId: "db-test",
      tables: [],
    });
  });
});
