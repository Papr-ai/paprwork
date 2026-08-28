import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

describe("replica single-engine enforcement", () => {
  useIsolatedPaprWorkspace();
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("openWritableLocalJobDb throws on replica-managed paths", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";
    process.env.CLOUD_SYNC_ENABLED = "true";

    const registryMod = await import(
      "../src/gateway/services/DatabaseRegistryService.js"
    );
    const { openWritableLocalJobDb } = await import(
      "../src/gateway/services/tursoSyncBridgeCore.js"
    );

    const dbPath = "/tmp/Papr/data/databases/replica-ui-test/data.db";
    const registry = registryMod.getDatabaseRegistryService();
    vi.spyOn(registry, "getByPath").mockImplementation((p: string) => {
      if (p === dbPath) {
        return {
          dbId: "db-test",
          localPath: dbPath,
          syncMode: "replica",
          tursoShortName: "d-test0001",
          isolation: "shared",
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
      }
      return undefined;
    });

    expect(() => openWritableLocalJobDb(dbPath)).toThrow(
      /must use @tursodatabase\/sync/,
    );
  });

  it("applyDatabaseMigrations routes replica paths away from better-sqlite3", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";
    process.env.CLOUD_SYNC_ENABLED = "true";

    const registryMod = await import(
      "../src/gateway/services/DatabaseRegistryService.js"
    );
    const replicaMigrations = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaRegistryMigrations.js"
    );
    vi.spyOn(
      replicaMigrations,
      "applyReplicaRegistryDatabaseMigrations",
    ).mockResolvedValue(["0002_test.sql"]);

    const dbPath = "/tmp/Papr/data/databases/replica-ui-test/data.db";
    const registry = registryMod.getDatabaseRegistryService();
    vi.spyOn(registry, "getByPath").mockImplementation((p: string) => {
      if (p === dbPath) {
        return {
          dbId: "db-test",
          localPath: dbPath,
          syncMode: "replica",
          tursoShortName: "d-test0001",
          isolation: "shared",
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
      }
      return undefined;
    });

    const { applyDatabaseMigrations } = await import(
      "../src/gateway/services/jobs/databaseMigrations.js"
    );

    const applied = await applyDatabaseMigrations(
      "/tmp/Papr/data/databases/replica-ui-test",
      dbPath,
    );

    expect(replicaMigrations.applyReplicaRegistryDatabaseMigrations).toHaveBeenCalledWith(
      "/tmp/Papr/data/databases/replica-ui-test",
      dbPath,
    );
    expect(applied).toEqual(["0002_test.sql"]);
  });
});
