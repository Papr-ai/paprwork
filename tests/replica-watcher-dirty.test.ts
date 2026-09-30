import { describe, expect, it, vi } from "vitest";

describe("isReplicaLinkedDbDirtyForWatcher", () => {
  it("returns true when local mutation is ahead of last push", async () => {
    const registryMod = await import(
      "../src/gateway/services/DatabaseRegistryService.js",
    );
    vi.spyOn(registryMod, "getDatabaseRegistryService").mockReturnValue({
      getById: () => ({
        dbId: "db-test",
        localPath: "/tmp/data.db",
        tursoShortName: "d-test0001",
        isolation: "shared",
        status: "active",
        syncMode: "replica",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastReplicaPushAt: "2026-01-01T00:00:00.000Z",
        lastReplicaLocalMutationAt: "2026-01-02T00:00:00.000Z",
      }),
      getByPath: () => undefined,
    } as ReturnType<typeof registryMod.getDatabaseRegistryService>);

    const { isReplicaLinkedDbDirtyForWatcher } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaRouting.js",
    );

    expect(
      isReplicaLinkedDbDirtyForWatcher({
        dbId: "db-test",
        dbPath: "/tmp/data.db",
      }),
    ).toBe(true);
  });

  it("returns false when push covers the latest local mutation", async () => {
    const registryMod = await import(
      "../src/gateway/services/DatabaseRegistryService.js",
    );
    vi.spyOn(registryMod, "getDatabaseRegistryService").mockReturnValue({
      getById: () => ({
        dbId: "db-test",
        localPath: "/tmp/data.db",
        tursoShortName: "d-test0001",
        isolation: "shared",
        status: "active",
        syncMode: "replica",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastReplicaPushAt: "2026-01-02T00:00:00.000Z",
        lastReplicaLocalMutationAt: "2026-01-01T00:00:00.000Z",
      }),
      getByPath: () => undefined,
    } as ReturnType<typeof registryMod.getDatabaseRegistryService>);

    const { isReplicaLinkedDbDirtyForWatcher } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaRouting.js",
    );

    expect(
      isReplicaLinkedDbDirtyForWatcher({
        dbId: "db-test",
        dbPath: "/tmp/data.db",
      }),
    ).toBe(false);
  });
});
