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

  it("marks pending when last push error is set", () => {
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
});

describe("tursoReplicaPathScheduler", () => {
  it("runs interactive ops before queued background ops", async () => {
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
  });
});
