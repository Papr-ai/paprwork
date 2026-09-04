import { afterEach, describe, expect, it, vi } from "vitest";
import { installInProcessSyncWorker } from "./helpers/inProcessSyncWorker.js";

describe("attachTursoReplicaInPlaceForCutover", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.CLOUD_SYNC_ENABLED;
    delete process.env.PAPR_TURSO_REPLICA_SYNC;
  });

  it("pulls without wiping data.db or pushing", async () => {
    process.env.CLOUD_SYNC_ENABLED = "true";
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";

    const pull = vi.fn(async () => true);
    const push = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const exec = vi.fn(async () => undefined);
    const removeAll = vi.fn();
    const removeSidecars = vi.fn();

    vi.doMock("fs", () => ({
      existsSync: vi.fn(() => true),
      promises: { mkdir: vi.fn(async () => undefined) },
    }));
    vi.doMock("../src/gateway/utils/tursoReplicaEnabled.js", () => ({
      isTursoReplicaOnline: () => true,
      isTursoReplicaSyncFeatureEnabled: () => true,
    }));
    vi.doMock("../src/gateway/utils/cloudSyncEnabled.js", () => ({
      isCloudSyncEnabled: () => true,
    }));
    vi.doMock("../src/gateway/services/TursoSyncBridge.js", () => ({
      getTursoSyncBridge: () => ({
        fetchCredentials: vi.fn(async () => ({
          tursoUrl: "libsql://example.turso.io",
          authToken: "token",
        })),
      }),
    }));
    vi.doMock("../src/gateway/services/tursoReplica/tursoReplicaConnect.js", () => ({
      connectTursoReplica: vi.fn(async (opts: { bootstrapIfEmpty?: boolean }) => {
        expect(opts.bootstrapIfEmpty).toBe(false);
        return { exec, pull, push, close };
      }),
    }));
    installInProcessSyncWorker();
    vi.doMock("../src/gateway/services/tursoReplica/tursoReplicaFileGuard.js", () => ({
      removeTursoReplicaLocalFiles: removeAll,
      removeTursoReplicaSidecarsOnly: removeSidecars,
    }));
    vi.doMock("../src/gateway/services/tursoSyncState.js", () => ({
      clearLegacyTursoSyncStateForDbPath: vi.fn(() => 1),
    }));
    vi.doMock("../src/gateway/services/legacyCdcArtifacts.js", () => ({
      stripLegacySyncPathArtifacts: vi.fn(() => ["_papr_oplog"]),
    }));
    vi.doMock("../src/gateway/services/tursoReplica/tursoReplicaSchemaLedger.js", () => ({
      ensureReplicaSchemaMigrationsLedger: vi.fn(async () => {}),
    }));

    const { attachTursoReplicaInPlaceForCutover } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaProvision.js"
    );

    await attachTursoReplicaInPlaceForCutover({
      dbId: "db-test",
      localPath: "/tmp/data/databases/test/data.db",
      tursoShortName: "d-test1234",
      isolation: "shared",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(removeSidecars).toHaveBeenCalledTimes(1);
    expect(removeAll).not.toHaveBeenCalled();
    expect(pull).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("provisionTursoReplicaForCutover", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.CLOUD_SYNC_ENABLED;
    delete process.env.PAPR_TURSO_REPLICA_SYNC;
  });

  it("pulls remote truth without push on legacy cutover provision", async () => {
    process.env.CLOUD_SYNC_ENABLED = "true";
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";

    const pull = vi.fn(async () => true);
    const push = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const exec = vi.fn(async () => undefined);

    vi.doMock("../src/gateway/utils/tursoReplicaEnabled.js", () => ({
      isTursoReplicaOnline: () => true,
      isTursoReplicaSyncFeatureEnabled: () => true,
    }));
    vi.doMock("../src/gateway/utils/cloudSyncEnabled.js", () => ({
      isCloudSyncEnabled: () => true,
    }));
    vi.doMock("../src/gateway/services/TursoSyncBridge.js", () => ({
      getTursoSyncBridge: () => ({
        fetchCredentials: vi.fn(async () => ({
          tursoUrl: "libsql://example.turso.io",
          authToken: "token",
        })),
      }),
    }));
    vi.doMock("../src/gateway/services/tursoReplica/tursoReplicaConnect.js", () => ({
      connectTursoReplica: vi.fn(async () => ({ exec, pull, push, close })),
    }));
    installInProcessSyncWorker();
    vi.doMock("../src/gateway/services/tursoReplica/tursoReplicaFileGuard.js", () => ({
      removeTursoReplicaLocalFiles: vi.fn(),
    }));
    vi.doMock("../src/gateway/services/tursoReplica/tursoReplicaSchemaLedger.js", () => ({
      ensureReplicaSchemaMigrationsLedger: vi.fn(async () => {}),
    }));

    const { provisionTursoReplicaForCutover } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaProvision.js"
    );

    await provisionTursoReplicaForCutover({
      dbId: "db-test",
      localPath: "/tmp/data/databases/test/data.db",
      tursoShortName: "d-test1234",
      isolation: "shared",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(pull).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("still push+pull for brand-new replica provisioning", async () => {
    process.env.CLOUD_SYNC_ENABLED = "true";
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";

    const pull = vi.fn(async () => true);
    const push = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const exec = vi.fn(async () => undefined);

    vi.doMock("../src/gateway/utils/tursoReplicaEnabled.js", () => ({
      isTursoReplicaOnline: () => true,
      isTursoReplicaSyncFeatureEnabled: () => true,
    }));
    vi.doMock("../src/gateway/utils/cloudSyncEnabled.js", () => ({
      isCloudSyncEnabled: () => true,
    }));
    vi.doMock("../src/gateway/services/TursoSyncBridge.js", () => ({
      getTursoSyncBridge: () => ({
        fetchCredentials: vi.fn(async () => ({
          tursoUrl: "libsql://example.turso.io",
          authToken: "token",
        })),
      }),
    }));
    vi.doMock("../src/gateway/services/tursoReplica/tursoReplicaConnect.js", () => ({
      connectTursoReplica: vi.fn(async () => ({ exec, pull, push, close })),
    }));
    installInProcessSyncWorker();
    vi.doMock("../src/gateway/services/tursoReplica/tursoReplicaFileGuard.js", () => ({
      removeTursoReplicaLocalFiles: vi.fn(),
    }));
    vi.doMock("../src/gateway/services/tursoReplica/tursoReplicaSchemaLedger.js", () => ({
      ensureReplicaSchemaMigrationsLedger: vi.fn(async () => {}),
    }));

    const { provisionTursoReplicaForRecord } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaProvision.js"
    );

    await provisionTursoReplicaForRecord({
      dbId: "db-test",
      localPath: "/tmp/data/databases/test/data.db",
      tursoShortName: "d-test1234",
      isolation: "shared",
      status: "active",
      syncMode: "replica",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(pull).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
  });
});
