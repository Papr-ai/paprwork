import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

describe("tursoReplicaFileGuard", () => {
  useIsolatedPaprWorkspace();
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("detects replica-managed db paths from registry", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";
    process.env.CLOUD_SYNC_ENABLED = "true";

    const registryMod = await import(
      "../src/gateway/services/DatabaseRegistryService.js"
    );
    const { isReplicaManagedDbPath } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaFileGuard.js"
    );

    const registry = registryMod.getDatabaseRegistryService();
    const dbPath = "/tmp/Papr/data/databases/replica-ui-test/data.db";
    vi.spyOn(registry, "getByPath").mockImplementation((p: string) => {
      if (p === dbPath) {
        return {
          dbId: "db-6ca6fa3c",
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

    expect(isReplicaManagedDbPath(dbPath)).toBe(true);
    expect(isReplicaManagedDbPath("/tmp/other/data.db")).toBe(false);
  });

  it("blocks better-sqlite3 access on replica-managed paths", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";
    process.env.CLOUD_SYNC_ENABLED = "true";

    const registryMod = await import(
      "../src/gateway/services/DatabaseRegistryService.js"
    );
    const {
      assertNotReplicaManagedSqliteAccess,
      ReplicaManagedDbAccessError,
    } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaFileGuard.js"
    );

    const registry = registryMod.getDatabaseRegistryService();
    const dbPath = "/tmp/Papr/data/databases/replica-block-test/data.db";
    vi.spyOn(registry, "getByPath").mockImplementation((p: string) => {
      if (p === dbPath) {
        return {
          dbId: "db-block-test",
          localPath: dbPath,
          syncMode: "replica",
          tursoShortName: "d-block001",
          isolation: "shared",
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
      }
      return undefined;
    });

    expect(() =>
      assertNotReplicaManagedSqliteAccess(dbPath, "test.read"),
    ).toThrow(ReplicaManagedDbAccessError);
    expect(() =>
      assertNotReplicaManagedSqliteAccess("/tmp/other/data.db", "test.read"),
    ).not.toThrow();
  });
});
