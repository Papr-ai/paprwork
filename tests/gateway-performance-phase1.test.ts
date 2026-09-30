import { describe, expect, it, beforeEach } from "vitest";
import {
  buildReplicaTursoSyncStatusFromRegistry,
} from "../src/gateway/services/tursoSyncStatus.js";
import type { DatabaseRecord } from "../src/gateway/services/DatabaseRegistryService.js";
import {
  clearTursoSyncItemsCacheForTests,
  getCachedTursoSyncItemsReport,
  invalidateTursoSyncItemsCache,
  setCachedTursoSyncItemsReport,
  tursoSyncItemsCacheKey,
} from "../src/gateway/services/tursoSyncItemsCache.js";
import {
  buildLocalDbReadCacheKey,
  clearLocalDbReadCacheForTests,
  getCachedLocalDbReadResult,
  invalidateLocalDbReadCacheForApp,
  setCachedLocalDbReadResult,
} from "../src/gateway/services/appRuntime/localDbReadCache.js";
import {
  isReplicaReadPathDegraded,
  noteReplicaReadPathFailure,
  clearReplicaReadPathDegraded,
  resetReplicaBackgroundRecoveryForTests,
  scheduleReplicaBackgroundWedgeRecovery,
} from "../src/gateway/services/tursoReplica/tursoReplicaBackgroundRecovery.js";
import { TursoReplicaPathScheduler } from "../src/gateway/services/tursoReplica/tursoReplicaPathScheduler.js";
import type { TursoReplicaService } from "../src/gateway/services/tursoReplica/TursoReplicaService.js";

describe("buildReplicaTursoSyncStatusFromRegistry", () => {
  it("marks pending when local mutation is newer than last push", () => {
    const record: DatabaseRecord = {
      dbId: "abc",
      localPath: "/tmp/data.db",
      tursoShortName: "d-abc12345",
      isolation: "shared",
      status: "active",
      lastReplicaPushAt: "2026-01-01T00:00:00.000Z",
      lastReplicaLocalMutationAt: "2026-01-02T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const status = buildReplicaTursoSyncStatusFromRegistry(record, record.localPath);
    expect(status.pendingPush).toBe(true);
    expect(status.stats).toBeNull();
  });

  it("marks pending when last push error is set without a covering push", () => {
    const record: DatabaseRecord = {
      dbId: "abc",
      localPath: "/tmp/data.db",
      tursoShortName: "d-abc12345",
      isolation: "shared",
      status: "active",
      lastReplicaPushError: "push failed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const status = buildReplicaTursoSyncStatusFromRegistry(record, record.localPath);
    expect(status.pendingPush).toBe(true);
  });

  it("does not mark pending when push succeeded after last mutation despite stale error", () => {
    const record: DatabaseRecord = {
      dbId: "abc",
      localPath: "/tmp/data.db",
      tursoShortName: "d-abc12345",
      isolation: "shared",
      status: "active",
      lastReplicaPushError: "short read on WAL frame",
      lastReplicaPushAt: "2026-09-06T12:00:00.000Z",
      lastReplicaLocalMutationAt: "2026-09-06T11:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-09-06T12:00:00.000Z",
    };
    const status = buildReplicaTursoSyncStatusFromRegistry(record, record.localPath);
    expect(status.pendingPush).toBe(false);
  });
});

describe("tursoSyncItemsCache", () => {
  beforeEach(() => {
    clearTursoSyncItemsCacheForTests();
  });

  it("stores and returns cached reports until invalidated", () => {
    const key = tursoSyncItemsCacheKey("app-1");
    const report = {
      enabled: true,
      databaseMode: "per-job" as const,
      lastCheckedAt: new Date().toISOString(),
      items: [],
      error: null,
    };
    setCachedTursoSyncItemsReport(key, report, 60_000);
    expect(getCachedTursoSyncItemsReport(key)).toEqual(report);
    invalidateTursoSyncItemsCache("app-1");
    expect(getCachedTursoSyncItemsReport(key)).toBeNull();
  });
});

describe("localDbReadCache", () => {
  beforeEach(() => {
    clearLocalDbReadCacheForTests();
  });

  it("caches read results per app and invalidates on write", () => {
    const key = buildLocalDbReadCacheKey({
      appId: "app-1",
      sourceKey: "main",
      sql: "SELECT 1",
      params: [],
    });
    const payload = { rows: [{ one: 1 }], count: 1 };
    setCachedLocalDbReadResult(key, payload, "app-1");
    expect(getCachedLocalDbReadResult(key)).toEqual(payload);
    invalidateLocalDbReadCacheForApp("app-1");
    expect(getCachedLocalDbReadResult(key)).toBeUndefined();
  });
});

describe("tursoReplicaBackgroundRecovery", () => {
  beforeEach(() => {
    resetReplicaBackgroundRecoveryForTests();
  });

  it("schedules background recovery once per cooldown window", async () => {
    let recoverCalls = 0;
    let pullCalls = 0;
    const service = {
      recoverReadWedgeForBackground: async () => {
        recoverCalls += 1;
      },
      pullForBackgroundRecovery: async () => {
        pullCalls += 1;
        return true;
      },
    } as unknown as TursoReplicaService;

    scheduleReplicaBackgroundWedgeRecovery(service, "/tmp/data.db", "d-test");
    scheduleReplicaBackgroundWedgeRecovery(service, "/tmp/data.db", "d-test");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(recoverCalls).toBe(1);
    expect(pullCalls).toBe(1);
  });

  it("marks path degraded after repeated read failures", () => {
    noteReplicaReadPathFailure("/tmp/wedge.db");
    noteReplicaReadPathFailure("/tmp/wedge.db");
    expect(isReplicaReadPathDegraded("/tmp/wedge.db")).toBe(true);
  });

  it("clears degraded state after successful local read", () => {
    noteReplicaReadPathFailure("/tmp/wedge.db");
    noteReplicaReadPathFailure("/tmp/wedge.db");
    clearReplicaReadPathDegraded("/tmp/wedge.db");
    expect(isReplicaReadPathDegraded("/tmp/wedge.db")).toBe(false);
  });
});

describe("tursoReplicaPathScheduler", () => {
  it("does not overlap reads with background sync in relaxed mode (default)", async () => {
    const prevStrict = process.env.PAPR_REPLICA_STRICT_PATH_QUEUE;
    const prevDuring = process.env.PAPR_REPLICA_READ_DURING_SYNC;
    delete process.env.PAPR_REPLICA_STRICT_PATH_QUEUE;
    delete process.env.PAPR_REPLICA_READ_DURING_SYNC;
    const scheduler = new TursoReplicaPathScheduler();
    const order: string[] = [];
    let releaseBg: () => void = () => undefined;
    const bgGate = new Promise<void>((resolve) => {
      releaseBg = resolve;
    });

    const bg = scheduler.runBackground("/tmp/data.db", async () => {
      order.push("bg-start");
      await bgGate;
      order.push("bg-end");
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    const read = scheduler.runParallelRead("/tmp/data.db", async () => {
      order.push("read");
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    releaseBg();
    await bg;
    await read;

    expect(order).toEqual(["bg-start", "bg-end", "read"]);
    if (prevStrict === undefined) {
      delete process.env.PAPR_REPLICA_STRICT_PATH_QUEUE;
    } else {
      process.env.PAPR_REPLICA_STRICT_PATH_QUEUE = prevStrict;
    }
    if (prevDuring === undefined) {
      delete process.env.PAPR_REPLICA_READ_DURING_SYNC;
    } else {
      process.env.PAPR_REPLICA_READ_DURING_SYNC = prevDuring;
    }
  });

  it("allows read during background sync when PAPR_REPLICA_READ_DURING_SYNC=1", async () => {
    const prevStrict = process.env.PAPR_REPLICA_STRICT_PATH_QUEUE;
    const prevDuring = process.env.PAPR_REPLICA_READ_DURING_SYNC;
    delete process.env.PAPR_REPLICA_STRICT_PATH_QUEUE;
    process.env.PAPR_REPLICA_READ_DURING_SYNC = "1";
    const scheduler = new TursoReplicaPathScheduler();
    const order: string[] = [];
    let releaseBg: () => void = () => undefined;
    const bgGate = new Promise<void>((resolve) => {
      releaseBg = resolve;
    });

    const bg = scheduler.runBackground("/tmp/data.db", async () => {
      order.push("bg-start");
      await bgGate;
      order.push("bg-end");
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    const read = scheduler.runParallelRead("/tmp/data.db", async () => {
      order.push("read");
    });

    await read;
    releaseBg();
    await bg;

    expect(order).toEqual(["bg-start", "read", "bg-end"]);
    if (prevStrict === undefined) {
      delete process.env.PAPR_REPLICA_STRICT_PATH_QUEUE;
    } else {
      process.env.PAPR_REPLICA_STRICT_PATH_QUEUE = prevStrict;
    }
    if (prevDuring === undefined) {
      delete process.env.PAPR_REPLICA_READ_DURING_SYNC;
    } else {
      process.env.PAPR_REPLICA_READ_DURING_SYNC = prevDuring;
    }
  });

  it("runs multiple parallel reads in relaxed mode", async () => {
    const prevStrict = process.env.PAPR_REPLICA_STRICT_PATH_QUEUE;
    delete process.env.PAPR_REPLICA_STRICT_PATH_QUEUE;
    const scheduler = new TursoReplicaPathScheduler();
    let concurrent = 0;
    let maxConcurrent = 0;

    await Promise.all(
      [1, 2, 3].map(() =>
        scheduler.runParallelRead("/tmp/data.db", async () => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((resolve) => setTimeout(resolve, 10));
          concurrent -= 1;
        }),
      ),
    );

    expect(maxConcurrent).toBeGreaterThan(1);
    if (prevStrict === undefined) {
      delete process.env.PAPR_REPLICA_STRICT_PATH_QUEUE;
    } else {
      process.env.PAPR_REPLICA_STRICT_PATH_QUEUE = prevStrict;
    }
  });

  it("runs interactive ops before queued background ops in strict mode", async () => {
    const prev = process.env.PAPR_REPLICA_STRICT_PATH_QUEUE;
    process.env.PAPR_REPLICA_STRICT_PATH_QUEUE = "1";
    const scheduler = new TursoReplicaPathScheduler();
    const order: string[] = [];
    let releaseBg1: () => void = () => undefined;
    const bg1Gate = new Promise<void>((resolve) => {
      releaseBg1 = resolve;
    });

    const bg1 = scheduler.runBackground("/tmp/data.db", async () => {
      order.push("bg1-start");
      await bg1Gate;
      order.push("bg1-end");
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    const bg2 = scheduler.runBackground("/tmp/data.db", async () => {
      order.push("bg2");
    });

    const interactive = scheduler.runInteractive("/tmp/data.db", async () => {
      order.push("interactive");
    });

    releaseBg1();
    await Promise.all([bg1, bg2, interactive]);

    expect(order).toEqual(["bg1-start", "bg1-end", "interactive", "bg2"]);
    if (prev === undefined) {
      delete process.env.PAPR_REPLICA_STRICT_PATH_QUEUE;
    } else {
      process.env.PAPR_REPLICA_STRICT_PATH_QUEUE = prev;
    }
  });
});
