import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDataSource } from "../src/gateway/services/appDataSources.js";

describe("tursoReplicaInboundDrain helpers", () => {
  it("listLocalOnlyMigrationIds finds ids not on remote", async () => {
    const { listLocalOnlyMigrationIds, hasLocalOnlyMigrationIds } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaMigrationConflict.js"
    );

    expect(
      listLocalOnlyMigrationIds(
        ["0001_baseline", "0005_device"],
        ["0001_baseline", "0006_cloud"],
      ),
    ).toEqual(["0005_device"]);
    expect(
      hasLocalOnlyMigrationIds(
        ["0001_baseline"],
        ["0001_baseline", "0006_cloud"],
      ),
    ).toBe(false);
  });
});

describe("drainInboundReplicaCdcIfCaughtUp", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  const source: AppDataSource = {
    id: "db-test",
    type: "sqlite",
    dbId: "db-test",
    alias: "todos",
    dbPath: "/tmp/data/databases/todos/data.db",
    tables: [],
    linkedAt: "2026-01-01T00:00:00.000Z",
  };

  it("skips drain when local-only migrations exist", async () => {
    process.env.CLOUD_SYNC_ENABLED = "true";
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";

    const migrationMod = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaMigrationConflict.js"
    );
    vi.spyOn(migrationMod, "readLocalReplicaMigrationIds").mockResolvedValue([
      "0001_baseline",
      "0005_device",
    ]);
    vi.spyOn(migrationMod, "readRemoteTursoMigrationIds").mockResolvedValue([
      "0001_baseline",
      "0006_cloud",
    ]);

    const push = vi.fn();
    const replicaMod = await import(
      "../src/gateway/services/tursoReplica/TursoReplicaService.js"
    );
    vi.spyOn(replicaMod, "getTursoReplicaService").mockReturnValue({
      readCdcOperations: vi.fn(async () => 2),
      push,
      checkpoint: vi.fn(),
    } as unknown as ReturnType<typeof replicaMod.getTursoReplicaService>);

    const { drainInboundReplicaCdcIfCaughtUp } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaInboundDrain.js"
    );

    const result = await drainInboundReplicaCdcIfCaughtUp({
      source,
      tursoDatabase: "d-test0001",
    });

    expect(result.drained).toBe(false);
    expect(result.skippedReason).toBe("local_only_migrations");
    expect(push).not.toHaveBeenCalled();

    delete process.env.CLOUD_SYNC_ENABLED;
    delete process.env.PAPR_TURSO_REPLICA_SYNC;
  });

  it("push+checkpoint when ledger caught up and cdcOperations > 0", async () => {
    process.env.CLOUD_SYNC_ENABLED = "true";
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";

    const migrationMod = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaMigrationConflict.js"
    );
    vi.spyOn(migrationMod, "readLocalReplicaMigrationIds").mockResolvedValue([
      "0001_baseline",
      "0006_cloud",
    ]);
    vi.spyOn(migrationMod, "readRemoteTursoMigrationIds").mockResolvedValue([
      "0001_baseline",
      "0006_cloud",
    ]);

    const push = vi.fn(async () => ({ ok: true as const }));
    const pull = vi.fn(async () => true);
    const checkpoint = vi.fn(async () => undefined);
    let cdcReads = 0;
    const readCdcOperations = vi.fn(async () => {
      cdcReads += 1;
      return cdcReads === 1 ? 2 : 0;
    });

    const replicaMod = await import(
      "../src/gateway/services/tursoReplica/TursoReplicaService.js"
    );
    vi.spyOn(replicaMod, "getTursoReplicaService").mockReturnValue({
      readCdcOperations,
      push,
      pull,
      checkpoint,
    } as unknown as ReturnType<typeof replicaMod.getTursoReplicaService>);

    const { drainInboundReplicaCdcIfCaughtUp } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaInboundDrain.js"
    );

    const result = await drainInboundReplicaCdcIfCaughtUp({
      source,
      tursoDatabase: "d-test0001",
    });

    expect(result.drained).toBe(true);
    expect(result.cdcOperationsBefore).toBe(2);
    expect(result.cdcOperationsAfter).toBe(0);
    expect(push).toHaveBeenCalledWith(source.dbPath, "d-test0001", {
      pullBeforePush: false,
    });
    expect(pull).toHaveBeenCalledWith(source.dbPath, "d-test0001");
    expect(checkpoint).toHaveBeenCalledTimes(1);

    delete process.env.CLOUD_SYNC_ENABLED;
    delete process.env.PAPR_TURSO_REPLICA_SYNC;
  });
});

describe("pullLinkedDbViaTursoReplica inbound drain", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("runs inbound drain after pull when online", async () => {
    process.env.CLOUD_SYNC_ENABLED = "true";
    process.env.PAPR_TURSO_REPLICA_SYNC = "force";

    const drain = vi.fn(async () => ({ drained: true }));
    vi.doMock(
      "../src/gateway/services/tursoReplica/tursoReplicaInboundDrain.js",
      () => ({
        drainInboundReplicaCdcIfCaughtUp: drain,
      }),
    );

    vi.doMock("../src/gateway/services/DatabaseRegistryService.js", () => ({
      resolveTursoDatabaseNameForSource: () => "d-test0001",
    }));

    vi.doMock("../src/gateway/services/tursoReplica/TursoReplicaService.js", () => ({
      getTursoReplicaService: () => ({
        pull: vi.fn(async () => true),
      }),
    }));

    const { pullLinkedDbViaTursoReplica } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaRouting.js"
    );

    const source: AppDataSource = {
      id: "db-test",
      type: "sqlite",
      dbId: "db-test",
      alias: "todos",
      dbPath: "/tmp/data/databases/todos/data.db",
      tables: [],
      linkedAt: "2026-01-01T00:00:00.000Z",
    };

    await pullLinkedDbViaTursoReplica(source);
    expect(drain).toHaveBeenCalledTimes(1);

    delete process.env.CLOUD_SYNC_ENABLED;
    delete process.env.PAPR_TURSO_REPLICA_SYNC;
  });
});
