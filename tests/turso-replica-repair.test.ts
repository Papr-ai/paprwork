import { describe, expect, it, vi, afterEach } from "vitest";

describe("tursoReplicaMigrationRebase", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("removes cloud-ahead migration ids from local ledger", async () => {
    const writeLinkedDbViaTursoReplica = vi
      .fn()
      .mockResolvedValueOnce({ changes: 1, pendingPush: true, backend: "turso-replica" })
      .mockResolvedValueOnce({ changes: 0, pendingPush: false, backend: "turso-replica" });

    vi.doMock("../src/gateway/services/tursoReplica/tursoReplicaRouting.js", () => ({
      writeLinkedDbViaTursoReplica,
    }));

    const { rebaseLocalMigrationLedger } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaMigrationRebase.js"
    );

    const source = {
      id: "db-1",
      type: "sqlite" as const,
      dbId: "db-1",
      alias: "billing",
      dbPath: "/tmp/billing/data.db",
      tables: [],
      linkedAt: "2026-01-01T00:00:00.000Z",
    };

    const removed = await rebaseLocalMigrationLedger(source, [
      "0007_offline",
      "0008_missing",
    ]);

    expect(removed).toEqual(["0007_offline"]);
    expect(writeLinkedDbViaTursoReplica).toHaveBeenCalledTimes(2);
  });
});

describe("repairCloudSync strategies", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("export_conflicts returns migration conflict details", async () => {
    vi.doMock("../src/gateway/services/DatabaseRegistryService.js", () => ({
      initializeDatabaseRegistry: vi.fn(async () => undefined),
      getDatabaseRegistryService: () => ({
        getById: () => ({
          dbId: "db-1",
          localPath: "/tmp/db.db",
          createdAt: "2026-01-01T00:00:00.000Z",
          syncMode: "replica",
        }),
        updateReplicaPushState: vi.fn(async () => undefined),
      }),
      tursoNameForRecord: () => "d-test0001",
    }));

    vi.doMock("../src/gateway/services/tursoReplica/tursoReplicaMigrationConflict.js", () => ({
      MIGRATION_CONFLICT_CODE: "MIGRATION_CONFLICT",
      checkMigrationPushConflict: vi.fn(async () => ({
        code: "MIGRATION_CONFLICT",
        message: "cloud ahead",
        localOnlyIds: ["0007_foo"],
        remoteOnlyIds: ["0008_bar"],
        cloudAheadIds: ["0007_foo"],
      })),
    }));

    vi.doMock("../src/gateway/services/tursoReplica/tursoReplicaRouting.js", () => ({
      syncStatusForLinkedDb: vi.fn(async () => ({
        online: true,
        syncMode: "replica",
        pendingPush: true,
        pendingOps: 2,
        cutoverBlocked: false,
        cutoverBlockReason: null,
        migrationConflict: true,
        lastPushError: null,
      })),
    }));

    const { repairCloudSync } = await import(
      "../src/gateway/services/tursoReplica/PaprDbService.js"
    );

    const result = await repairCloudSync({
      dbId: "db-1",
      strategy: "export_conflicts",
    });

    expect(result.conflicts?.cloudAheadMigrationIds).toEqual(["0007_foo"]);
    expect(result.syncStatus?.dbId).toBe("db-1");
  });

  it("bootstrap_remote pushes full snapshot then reseeds replica", async () => {
    const pushLocalLegacyFileToTursoPrimary = vi.fn(async () => undefined);
    const reseedTursoReplicaFromRemote = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);

    vi.doMock("../src/gateway/services/DatabaseRegistryService.js", () => ({
      initializeDatabaseRegistry: vi.fn(async () => undefined),
      getDatabaseRegistryService: () => ({
        getById: () => ({
          dbId: "db-ec8821e8",
          localPath: "/tmp/gtm/data.db",
          createdAt: "2026-01-01T00:00:00.000Z",
          syncMode: "replica",
        }),
        updateReplicaPushState: vi.fn(async () => undefined),
      }),
      tursoNameForRecord: () => "d-ec8821e8",
    }));

    vi.doMock("../src/gateway/services/tursoReplica/TursoReplicaService.js", () => ({
      getTursoReplicaService: () => ({ close }),
    }));

    vi.doMock("../src/gateway/services/tursoReplica/tursoReplicaProvision.js", () => ({
      pushLocalLegacyFileToTursoPrimary,
      reseedTursoReplicaFromRemote,
    }));

    vi.doMock("../src/gateway/services/tursoReplica/tursoReplicaRouting.js", () => ({
      syncStatusForLinkedDb: vi.fn(async () => ({
        online: true,
        syncMode: "replica",
        pendingPush: false,
        pendingOps: 0,
        cutoverBlocked: false,
        cutoverBlockReason: null,
        migrationConflict: false,
        lastPushError: null,
      })),
    }));

    vi.doMock("node:fs/promises", () => ({
      copyFile: vi.fn(async () => undefined),
    }));

    const { repairCloudSync } = await import(
      "../src/gateway/services/tursoReplica/PaprDbService.js"
    );

    const result = await repairCloudSync({
      dbId: "db-ec8821e8",
      strategy: "bootstrap_remote",
    });

    expect(pushLocalLegacyFileToTursoPrimary).toHaveBeenCalledOnce();
    expect(reseedTursoReplicaFromRemote).toHaveBeenCalledOnce();
    expect(result.push?.ok).toBe(true);
    expect(result.pull?.pulled).toBe(true);
  });
});
