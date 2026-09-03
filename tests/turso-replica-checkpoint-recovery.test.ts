import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CHECKPOINT_WAL_ERROR,
  tursoReplicaBridgeMock,
} from "./helpers/tursoReplicaBridgeMock.js";

describe("turso replica checkpoint wedge — production guarantees", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("TursoReplicaService.checkpoint is a no-op (never calls SDK checkpoint)", async () => {
    process.env.CLOUD_SYNC_ENABLED = "true";
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";

    const sdkCheckpoint = vi.fn(async () => undefined);

    vi.doMock("@tursodatabase/sync", () => ({
      connect: vi.fn(async () => ({
        connect: vi.fn(async () => undefined),
        pull: vi.fn(),
        push: vi.fn(),
        checkpoint: sdkCheckpoint,
        close: vi.fn(),
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
    await service.checkpoint("/tmp/x.db", "d-abc12345");
    expect(sdkCheckpoint).not.toHaveBeenCalled();
  });

  it("push succeeds without calling SDK checkpoint after push", async () => {
    process.env.CLOUD_SYNC_ENABLED = "true";
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";

    const pull = vi.fn(async () => true);
    const push = vi.fn(async () => undefined);
    const sdkCheckpoint = vi.fn(async () => undefined);

    vi.doMock("@tursodatabase/sync", () => ({
      connect: vi.fn(async () => ({
        connect: vi.fn(async () => undefined),
        pull,
        push,
        checkpoint: sdkCheckpoint,
        close: vi.fn(async () => undefined),
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
    const result = await service.push("/tmp/test-replica.db", "d-abc12345");

    expect(result.ok).toBe(true);
    expect(pull).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
    expect(sdkCheckpoint).not.toHaveBeenCalled();
  });

  it("runExec recovers from checkpoint WAL error by resetting sidecars and retrying sync", async () => {
    process.env.CLOUD_SYNC_ENABLED = "true";
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";

    let pullCalls = 0;
    const pull = vi.fn(async () => {
      pullCalls += 1;
      if (pullCalls === 1) {
        throw new Error(CHECKPOINT_WAL_ERROR);
      }
      return true;
    });
    const push = vi.fn(async () => undefined);

    vi.doMock("@tursodatabase/sync", () => ({
      connect: vi.fn(async () => ({
        connect: vi.fn(async () => undefined),
        pull,
        push,
        close: vi.fn(async () => undefined),
        exec: vi.fn(async () => undefined),
        prepare: vi.fn(),
        stats: vi.fn(async () => ({ cdcOperations: 0 })),
      })),
    }));

    vi.doMock("../src/gateway/services/TursoSyncBridge.js", () =>
      tursoReplicaBridgeMock(),
    );

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-recovery-exec-"));
    const dbPath = path.join(dir, "data.db");
    fs.writeFileSync(dbPath, "sqlite");

    const fileGuard = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaFileGuard.js"
    );
    const removeSidecars = vi.spyOn(fileGuard, "removeTursoReplicaSidecarsOnly");

    const { getTursoReplicaService, resetTursoReplicaServiceForTests } =
      await import("../src/gateway/services/tursoReplica/TursoReplicaService.js");
    resetTursoReplicaServiceForTests();

    const service = getTursoReplicaService();
    const result = await service.runExec(dbPath, "d-abc12345", "CREATE TABLE t(id INTEGER)");

    expect(result.pendingPush).toBe(false);
    expect(pull).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenCalledTimes(1);
    expect(removeSidecars).toHaveBeenCalledWith(dbPath);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("pull recovers from checkpoint WAL error after sidecar reset", async () => {
    process.env.CLOUD_SYNC_ENABLED = "true";
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";

    let pullCalls = 0;
    const pull = vi.fn(async () => {
      pullCalls += 1;
      if (pullCalls === 1) {
        throw new Error(CHECKPOINT_WAL_ERROR);
      }
      return true;
    });

    vi.doMock("@tursodatabase/sync", () => ({
      connect: vi.fn(async () => ({
        connect: vi.fn(async () => undefined),
        pull,
        close: vi.fn(async () => undefined),
        push: vi.fn(),
        exec: vi.fn(),
        prepare: vi.fn(),
        stats: vi.fn(async () => ({ cdcOperations: 0 })),
      })),
    }));

    vi.doMock("../src/gateway/services/TursoSyncBridge.js", () =>
      tursoReplicaBridgeMock(),
    );

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-recovery-pull-"));
    const dbPath = path.join(dir, "data.db");
    fs.writeFileSync(dbPath, "sqlite");

    const fileGuard = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaFileGuard.js"
    );
    const removeSidecars = vi.spyOn(fileGuard, "removeTursoReplicaSidecarsOnly");

    const { getTursoReplicaService, resetTursoReplicaServiceForTests } =
      await import("../src/gateway/services/tursoReplica/TursoReplicaService.js");
    resetTursoReplicaServiceForTests();

    const service = getTursoReplicaService();
    const pulled = await service.pull(dbPath, "d-abc12345");

    expect(pulled).toBe(true);
    expect(pull).toHaveBeenCalledTimes(2);
    expect(removeSidecars).toHaveBeenCalledWith(dbPath);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("syncStatus repairs an unsatisfiable watermark on connect and reports healthy", async () => {
    process.env.CLOUD_SYNC_ENABLED = "true";
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";

    vi.doMock("@tursodatabase/sync", () => ({
      connect: vi.fn(async () => ({
        connect: vi.fn(async () => undefined),
        pull: vi.fn(),
        push: vi.fn(),
        close: vi.fn(async () => undefined),
        exec: vi.fn(),
        prepare: vi.fn(),
        stats: vi.fn(async () => ({ cdcOperations: 2 })),
      })),
    }));

    vi.doMock("../src/gateway/services/TursoSyncBridge.js", () =>
      tursoReplicaBridgeMock(),
    );

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-wedge-status-"));
    const dbPath = path.join(dir, "data.db");
    fs.writeFileSync(dbPath, "sqlite");
    fs.writeFileSync(`${dbPath}-wal`, "");
    fs.writeFileSync(
      `${dbPath}-info`,
      JSON.stringify({
        revert_since_wal_watermark: 12,
        synced_revision: {
          revision: JSON.stringify({ wal_fragment_no: 78 }),
        },
      }),
    );

    const { getTursoReplicaService, resetTursoReplicaServiceForTests } =
      await import("../src/gateway/services/tursoReplica/TursoReplicaService.js");
    resetTursoReplicaServiceForTests();

    const service = getTursoReplicaService();
    const status = await service.syncStatus({
      localPath: dbPath,
      tursoDatabase: "d-abc12345",
      syncMode: "replica",
    });

    // watermark=12 against an empty WAL is unsatisfiable: the engine would abort the
    // process resolving it, so opening the replica resets the sidecars first. By the time
    // status is computed the replica is genuinely no longer wedged.
    expect(fs.existsSync(`${dbPath}-info`)).toBe(false);
    expect(status.sidecarWedge).toBe(false);
    expect(status.pendingOps).toBe(2);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("recoverReplicaAfterCheckpointError resets sidecars before pull", async () => {
    process.env.CLOUD_SYNC_ENABLED = "true";
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-routing-recover-"));
    const dbPath = path.join(dir, "data.db");
    fs.writeFileSync(dbPath, "sqlite-data");
    fs.writeFileSync(`${dbPath}-wal`, "");
    fs.writeFileSync(
      `${dbPath}-info`,
      JSON.stringify({
        revert_since_wal_watermark: 5,
        synced_revision: {
          revision: JSON.stringify({ wal_fragment_no: 3 }),
        },
      }),
    );

    const close = vi.fn(async () => undefined);
    const pull = vi.fn(async () => true);

    vi.doMock("../src/gateway/services/tursoReplica/TursoReplicaService.js", () => ({
      getTursoReplicaService: () => ({ close, pull }),
    }));

    vi.doMock(
      "../src/gateway/services/tursoReplica/tursoReplicaInboundDrain.js",
      () => ({
        drainInboundReplicaCdcIfCaughtUp: vi.fn(async () => ({
          drained: false,
          skippedReason: "no_cdc",
          cdcOperationsBefore: 0,
          cdcOperationsAfter: 0,
        })),
      }),
    );

    vi.doMock("../src/gateway/services/DatabaseRegistryService.js", () => ({
      getDatabaseRegistryService: () => ({
        updateReplicaPushState: vi.fn(async () => undefined),
      }),
    }));

    const { recoverReplicaAfterCheckpointError } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaRouting.js"
    );

    const source = {
      id: "db-1",
      type: "sqlite" as const,
      dbId: "db-1",
      alias: "billing",
      dbPath,
      tables: [],
      linkedAt: "2026-01-01T00:00:00.000Z",
    };

    const recovered = await recoverReplicaAfterCheckpointError(
      source,
      "d-abc12345",
    );

    expect(recovered).toBe(true);
    expect(close).toHaveBeenCalledWith(dbPath);
    expect(pull).toHaveBeenCalledWith(dbPath, "d-abc12345");
    expect(fs.existsSync(`${dbPath}-info`)).toBe(false);
    expect(fs.readFileSync(dbPath, "utf8")).toBe("sqlite-data");

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
