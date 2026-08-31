import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDataSource } from "../src/gateway/services/appDataSources.js";
import { tursoReplicaBridgeMock } from "./helpers/tursoReplicaBridgeMock.js";

describe("tursoReplicaSchemaLedger", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("creates schema_migrations when missing (offline replica path)", async () => {
    process.env.CLOUD_SYNC_ENABLED = "false";

    const execLinkedDbViaTursoReplica = vi.fn(async () => ({ pendingPush: false }));
    const writeLinkedDbViaTursoReplica = vi.fn(async () => ({
      changes: 1,
      lastInsertRowid: 0,
      pendingPush: false,
      backend: "turso-replica" as const,
    }));
    const queryLinkedDbViaTursoReplica = vi.fn(async () => ({
      rows: [],
      columns: [],
      count: 0,
    }));

    vi.doMock("../src/gateway/services/tursoReplica/tursoReplicaRouting.js", () => ({
      execLinkedDbViaTursoReplica,
      writeLinkedDbViaTursoReplica,
      queryLinkedDbViaTursoReplica,
    }));

    const { ensureReplicaSchemaMigrationsLedger } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaSchemaLedger.js"
    );

    const source: AppDataSource = {
      id: "db-test",
      type: "sqlite",
      dbId: "db-test",
      alias: "billing",
      dbPath: "/tmp/data/databases/billing/data.db",
      tables: [],
      linkedAt: new Date().toISOString(),
    };

    await ensureReplicaSchemaMigrationsLedger(source);

    expect(execLinkedDbViaTursoReplica).toHaveBeenCalledTimes(1);
    expect(writeLinkedDbViaTursoReplica).toHaveBeenCalledWith(
      source,
      "INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))",
      ["0001_baseline"],
    );

    delete process.env.CLOUD_SYNC_ENABLED;
  });

  it("pulls and writes baseline on local replica when online", async () => {
    process.env.CLOUD_SYNC_ENABLED = "true";
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";

    const execLinkedDbViaTursoReplica = vi.fn(async () => ({ pendingPush: false }));
    const writeLinkedDbViaTursoReplica = vi.fn(async () => ({
      changes: 1,
      lastInsertRowid: 0,
      pendingPush: false,
      backend: "turso-replica" as const,
    }));
    const queryLinkedDbViaTursoReplica = vi.fn(async () => ({
      rows: [],
      columns: [],
      count: 0,
    }));
    const pullLinkedDbViaTursoReplica = vi.fn(async () => true);

    vi.doMock("../src/gateway/services/tursoReplica/tursoReplicaRouting.js", () => ({
      execLinkedDbViaTursoReplica,
      writeLinkedDbViaTursoReplica,
      queryLinkedDbViaTursoReplica,
      pullLinkedDbViaTursoReplica,
    }));

    const { ensureReplicaSchemaMigrationsLedger } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaSchemaLedger.js"
    );

    const source: AppDataSource = {
      id: "db-test",
      type: "sqlite",
      dbId: "db-test",
      alias: "billing",
      dbPath: "/tmp/data/databases/billing/data.db",
      tables: [],
      linkedAt: new Date().toISOString(),
    };

    await ensureReplicaSchemaMigrationsLedger(source);

    expect(pullLinkedDbViaTursoReplica).toHaveBeenCalledTimes(1);
    expect(execLinkedDbViaTursoReplica).toHaveBeenCalledTimes(1);
    expect(writeLinkedDbViaTursoReplica).toHaveBeenCalledWith(
      source,
      "INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))",
      ["0001_baseline"],
    );

    delete process.env.CLOUD_SYNC_ENABLED;
    delete process.env.PAPR_TURSO_REPLICA_SYNC;
  });

  it("skips DDL when schema_migrations already exists", async () => {
    process.env.CLOUD_SYNC_ENABLED = "false";

    const execLinkedDbViaTursoReplica = vi.fn(async () => ({ pendingPush: false }));
    const writeLinkedDbViaTursoReplica = vi.fn(async () => ({
      changes: 0,
      lastInsertRowid: 0,
      pendingPush: false,
      backend: "turso-replica" as const,
    }));
    const queryLinkedDbViaTursoReplica = vi.fn(async () => ({
      rows: [{ name: "schema_migrations" }],
      columns: ["name"],
      count: 1,
    }));

    vi.doMock("../src/gateway/services/tursoReplica/tursoReplicaRouting.js", () => ({
      execLinkedDbViaTursoReplica,
      writeLinkedDbViaTursoReplica,
      queryLinkedDbViaTursoReplica,
    }));

    const { ensureReplicaSchemaMigrationsLedger } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaSchemaLedger.js"
    );

    const source: AppDataSource = {
      id: "db-test",
      type: "sqlite",
      dbId: "db-test",
      alias: "billing",
      dbPath: "/tmp/data/databases/billing/data.db",
      tables: [],
      linkedAt: new Date().toISOString(),
    };

    await ensureReplicaSchemaMigrationsLedger(source);

    expect(execLinkedDbViaTursoReplica).not.toHaveBeenCalled();
    expect(writeLinkedDbViaTursoReplica).toHaveBeenCalledTimes(1);

    delete process.env.CLOUD_SYNC_ENABLED;
  });
});
describe("tursoReplicaMigrationConflict", () => {
  it("detects cloud-ahead conflict when local offline migration is behind cloud head", async () => {
    const { detectMigrationPushConflict } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaMigrationConflict.js"
    );

    const conflict = detectMigrationPushConflict(
      ["0001_baseline", "0005_device"],
      ["0001_baseline", "0006_cloud_only"],
    );

    expect(conflict).not.toBeNull();
    expect(conflict?.code).toBe("MIGRATION_CONFLICT");
    expect(conflict?.cloudAheadIds).toContain("0005_device");
  });

  it("allows push when local-only migration is ahead of cloud", async () => {
    const { detectMigrationPushConflict } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaMigrationConflict.js"
    );

    const conflict = detectMigrationPushConflict(
      ["0001_baseline", "0007_foo"],
      ["0001_baseline", "0006_bar"],
    );

    expect(conflict).toBeNull();
  });
});

describe("tursoReplicaConnectivity", () => {
  afterEach(async () => {
    const { resetTursoReplicaConnectivityForTests } = await import(
      "../src/gateway/utils/tursoReplicaConnectivity.js"
    );
    resetTursoReplicaConnectivityForTests();
  });

  it("marks offline after transport errors and recovers on reachable", async () => {
    const {
      isTursoReplicaReachable,
      markTursoReplicaUnreachable,
      markTursoReplicaReachable,
      noteTursoReplicaTransportError,
      resetTursoReplicaConnectivityForTests,
    } = await import("../src/gateway/utils/tursoReplicaConnectivity.js");

    expect(isTursoReplicaReachable()).toBe(true);
    noteTursoReplicaTransportError(new Error("fetch failed: network down"));
    expect(isTursoReplicaReachable()).toBe(false);
    markTursoReplicaReachable();
    expect(isTursoReplicaReachable()).toBe(true);
    markTursoReplicaUnreachable({ durationMs: 60_000 });
    expect(isTursoReplicaReachable()).toBe(false);
    resetTursoReplicaConnectivityForTests();
  });
});

describe("TursoReplicaService.runWrite", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("pulls before push on write when online", async () => {
    process.env.CLOUD_SYNC_ENABLED = "true";
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";

    const pull = vi.fn(async () => true);
    const push = vi.fn(async () => undefined);
    const run = vi.fn(async () => ({ changes: 1, lastInsertRowid: 1 }));
    const prepare = vi.fn(async () => ({ run, all: vi.fn(async () => []) }));

    vi.doMock("@tursodatabase/sync", () => ({
      connect: vi.fn(async () => ({
        connect: vi.fn(async () => undefined),
        pull,
        push,
        close: vi.fn(async () => undefined),
        exec: vi.fn(),
        prepare,
        stats: vi.fn(async () => ({ cdcOperations: 0 })),
      })),
    }));

    vi.doMock("../src/gateway/services/TursoSyncBridge.js", () =>
      tursoReplicaBridgeMock(),
    );

    vi.doMock("fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("fs")>();
      return {
        ...actual,
        existsSync: vi.fn(() => true),
      };
    });

    const { getTursoReplicaService, resetTursoReplicaServiceForTests } =
      await import("../src/gateway/services/tursoReplica/TursoReplicaService.js");
    resetTursoReplicaServiceForTests();

    const service = getTursoReplicaService();
    await service.runWrite({
      localPath: "/tmp/test-replica.db",
      tursoDatabase: "d-abc12345",
      sql: "INSERT INTO t (id) VALUES (?)",
      params: [1],
    });

    expect(pull).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
    expect(pull.mock.invocationCallOrder[0]).toBeLessThan(
      push.mock.invocationCallOrder[0] ?? 0,
    );
  });
});

describe("TursoReplicaService.push", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("pulls before push when online (reconnect anti-drift)", async () => {
    process.env.CLOUD_SYNC_ENABLED = "true";
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";

    const pull = vi.fn(async () => true);
    const push = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);

    vi.doMock("@tursodatabase/sync", () => ({
      connect: vi.fn(async () => ({
        connect: vi.fn(async () => undefined),
        pull,
        push,
        close,
        exec: vi.fn(),
        prepare: vi.fn(),
        stats: vi.fn(async () => ({ cdcOperations: 0 })),
      })),
    }));

    vi.doMock("../src/gateway/services/TursoSyncBridge.js", () =>
      tursoReplicaBridgeMock(),
    );

    const { getTursoReplicaService, resetTursoReplicaServiceForTests } =
      await import("../src/gateway/services/tursoReplica/TursoReplicaService.js");
    resetTursoReplicaServiceForTests();

    const service = getTursoReplicaService();
    const result = await service.push("/tmp/test-replica.db", "d-abc12345");

    expect(result.ok).toBe(true);
    expect(pull).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
    expect(pull.mock.invocationCallOrder[0]).toBeLessThan(
      push.mock.invocationCallOrder[0] ?? 0,
    );
  });
});

describe("TursoReplicaService.syncStatus", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("pendingPush is true when lastPushError is set even with zero CDC ops", async () => {
    process.env.CLOUD_SYNC_ENABLED = "true";
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";

    vi.doMock("@tursodatabase/sync", () => ({
      connect: vi.fn(async () => ({
        connect: vi.fn(async () => undefined),
        pull: vi.fn(),
        push: vi.fn(),
        close: vi.fn(),
        exec: vi.fn(),
        prepare: vi.fn(),
        stats: vi.fn(async () => ({ cdcOperations: 0 })),
      })),
    }));

    vi.doMock("../src/gateway/services/TursoSyncBridge.js", () =>
      tursoReplicaBridgeMock(),
    );

    vi.doMock("fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("fs")>();
      return {
        ...actual,
        existsSync: vi.fn(() => true),
      };
    });

    const { getTursoReplicaService, resetTursoReplicaServiceForTests } =
      await import("../src/gateway/services/tursoReplica/TursoReplicaService.js");
    resetTursoReplicaServiceForTests();

    const service = getTursoReplicaService();
    const status = await service.syncStatus({
      localPath: "/tmp/test-replica.db",
      tursoDatabase: "d-abc12345",
      syncMode: "replica",
      lastPushError: "REPLICA_GEN_DRIFT: pull first",
    });

    expect(status.pendingOps).toBe(0);
    expect(status.pendingPush).toBe(true);
    expect(status.lastPushError).toContain("REPLICA_GEN_DRIFT");
  });

  it("reports pendingOps from replica stats without auto-reconcile", async () => {
    process.env.CLOUD_SYNC_ENABLED = "true";
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";

    const pull = vi.fn(async () => true);
    const push = vi.fn(async () => undefined);
    const stats = vi.fn(async () => ({ cdcOperations: 2 }));

    vi.doMock("@tursodatabase/sync", () => ({
      connect: vi.fn(async () => ({
        connect: vi.fn(async () => undefined),
        pull,
        push,
        close: vi.fn(),
        exec: vi.fn(),
        prepare: vi.fn(),
        stats,
      })),
    }));

    vi.doMock("../src/gateway/services/TursoSyncBridge.js", () =>
      tursoReplicaBridgeMock(),
    );

    vi.doMock("fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("fs")>();
      return {
        ...actual,
        existsSync: vi.fn(() => true),
      };
    });

    const { getTursoReplicaService, resetTursoReplicaServiceForTests } =
      await import("../src/gateway/services/tursoReplica/TursoReplicaService.js");
    resetTursoReplicaServiceForTests();

    const service = getTursoReplicaService();
    const status = await service.syncStatus({
      localPath: "/tmp/test-replica.db",
      tursoDatabase: "d-abc12345",
      syncMode: "replica",
    });

    expect(pull).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(stats).toHaveBeenCalledTimes(1);
    expect(status.pendingOps).toBe(2);
    expect(status.pendingPush).toBe(true);
  });
});

describe("tursoReplicaReconnect", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("drains replica DBs on reconnect after transport offline", async () => {
    process.env.PAPR_TURSO_REPLICA_TEST_DRAIN = "1";
    const pushLinkedDbViaTursoReplica = vi.fn(async () => ({ ok: true }));
    vi.doMock("../src/gateway/services/tursoReplica/tursoReplicaRouting.js", () => ({
      pushLinkedDbViaTursoReplica,
    }));

    vi.doMock("../src/gateway/services/DatabaseRegistryService.js", () => ({
      initializeDatabaseRegistry: vi.fn(async () => undefined),
      getDatabaseRegistryService: () => ({
        listActive: () => [
          {
            dbId: "db-1",
            localPath: "/tmp/db.db",
            createdAt: "2026-01-01T00:00:00.000Z",
            syncMode: "replica",
            label: "billing",
          },
        ],
        updateReplicaPushState: vi.fn(async () => undefined),
      }),
      tursoNameForRecord: () => "d-test0001",
    }));

    process.env.CLOUD_SYNC_ENABLED = "true";
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";

    const connectivity = await import(
      "../src/gateway/utils/tursoReplicaConnectivity.js"
    );
    connectivity.resetTursoReplicaConnectivityForTests();
    connectivity.markTursoReplicaUnreachable({ durationMs: 60_000 });
    expect(connectivity.isTursoReplicaReachable()).toBe(false);

    connectivity.markTursoReplicaReachable();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(pushLinkedDbViaTursoReplica).toHaveBeenCalledTimes(1);
    delete process.env.PAPR_TURSO_REPLICA_TEST_DRAIN;
    connectivity.resetTursoReplicaConnectivityForTests();
  });
});

describe("isDdlSql", () => {
  it("detects DDL statements", async () => {
    const { isDdlSql } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaPrimaryWrite.js"
    );
    expect(isDdlSql("CREATE TABLE t (id INTEGER PRIMARY KEY)")).toBe(true);
    expect(isDdlSql("INSERT INTO t VALUES (1)")).toBe(false);
  });
});

describe("tursoReplicaPostMigration", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("updates app-meta for schema owner after migration", async () => {
    const writeCloudAppMeta = vi.fn(async () => ({
      schemaVersion: "1.0.0" as const,
      distRevision: "abc",
      requiredSchemaVersion: "0003_add_owner",
    }));

    vi.doMock("../src/gateway/services/cloudSync/cloudAppMeta.js", () => ({
      writeCloudAppMeta,
    }));

    vi.doMock("../src/gateway/services/DatabaseRegistryService.js", () => ({
      getDatabaseRegistryService: () => ({
        getById: (dbId: string) =>
          dbId === "db-caf671ba"
            ? { schemaOwnerAppId: "app-todo" }
            : undefined,
      }),
    }));

    vi.doMock("../src/core/utils/paprRoot.js", () => ({
      getPaprRoot: () => "/tmp/papr",
    }));

    const { afterRegistryMigrationApplied } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaPostMigration.js"
    );

    const result = await afterRegistryMigrationApplied({
      dbId: "db-caf671ba",
      migrationId: "0003_add_owner",
      source: {
        id: "db-caf671ba",
        type: "sqlite",
        dbId: "db-caf671ba",
        alias: "todos",
        dbPath: "/tmp/data/databases/todo-list/data.db",
        tables: [],
        linkedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(result.appMetaUpdated).toBe(true);
    expect(result.schemaOwnerAppId).toBe("app-todo");
    expect(writeCloudAppMeta).toHaveBeenCalledWith("/tmp/papr", "app-todo");
  });
});
