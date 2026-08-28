import { afterEach, describe, expect, it, vi } from "vitest";

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
