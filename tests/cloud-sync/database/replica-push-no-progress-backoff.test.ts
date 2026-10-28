import { afterEach, describe, expect, it, vi } from "vitest";

describe("replica push scheduler: no-progress loop", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("backs off after 2 follow-ups when the replica stays pending", async () => {
    process.env.TURSO_PUSH_DEBOUNCE_MS = "0";
    process.env.TURSO_PUSH_MAX_WAIT_MS = "600000";
    process.env.TURSO_PUSH_INTERVAL_MS = "0";
    const push = vi.fn(async () => ({ ok: true }));
    vi.doMock("../../../src/gateway/utils/tursoReplicaEnabled.js", () => ({
      isTursoReplicaOnline: () => true,
      isTursoReplicaSyncFeatureEnabled: () => true,
    }));
    vi.doMock("../../../src/gateway/services/cloudUploadMode.js", () => ({
      shouldAutoUploadReplicaSyncKey: () => true,
    }));
    vi.doMock("../../../src/gateway/services/tursoReplica/replicaPublishHold.js", () => ({
      isSyncKeyHeld: () => false,
    }));
    vi.doMock("../../../src/gateway/services/tursoReplica/tursoReplicaPushInteractiveDefer.js", () => ({
      shouldDeferReplicaPushWhileInteractive: () => false,
    }));
    vi.doMock("../../../src/gateway/services/gatewayBackgroundWork.js", () => ({
      yieldToInteractiveHotPath: async () => undefined,
    }));
    vi.doMock("../../../src/gateway/services/TursoSyncBridge.js", () => ({
      ensureTursoSyncBridge: () => ({
        enabled: true,
        getAppsRootDir: () => "/tmp/apps",
        listLinkedSources: async () => [],
      }),
    }));
    vi.doMock("../../../src/gateway/services/DatabaseRegistryService.js", () => ({
      initializeDatabaseRegistry: async () => undefined,
      getDatabaseRegistryService: () => ({
        getById: (id: string) => id === "db-loop"
          ? { dbId: "db-loop", localPath: "/tmp/loop/data.db", syncMode: "replica", createdAt: "2026-01-01" }
          : undefined,
        getByPath: () => undefined,
      }),
    }));
    vi.doMock("../../../src/gateway/services/tursoReplica/tursoReplicaRouting.js", () => ({
      pushLinkedDbViaTursoReplica: push,
      shouldUseTursoReplicaForSource: () => true,
      // pending never clears — the state that made one replica pull ~10 GB/hour
      syncStatusForLinkedDb: async () => ({ pendingPush: true, lastPushError: null, migrationConflict: false }),
    }));

    const s = await import("../../../src/gateway/services/tursoReplica/tursoReplicaPushScheduler.js");
    s.scheduleTursoReplicaPushForSyncKey("db-loop", "normal", "manual");
    await new Promise((r) => setTimeout(r, 1500));

    expect(push).toHaveBeenCalledTimes(3);
    // in backoff: a non-manual schedule does nothing
    s.scheduleTursoReplicaPushForSyncKey("db-loop", "normal", "watcher");
    await new Promise((r) => setTimeout(r, 50));
    expect(push).toHaveBeenCalledTimes(3);
    s.resetTursoReplicaPushSchedulerForTests();
  });

  it("does not retry a held churn backlog until new writes arrive", async () => {
    process.env.TURSO_PUSH_DEBOUNCE_MS = "0";
    process.env.TURSO_PUSH_MAX_WAIT_MS = "600000";
    process.env.TURSO_PUSH_INTERVAL_MS = "0";
    const push = vi.fn(async () => ({ ok: false, error: "BACKLOG_HOLD: Upload held", backlogHold: true }));
    vi.doMock("../../../src/gateway/utils/tursoReplicaEnabled.js", () => ({
      isTursoReplicaOnline: () => true,
      isTursoReplicaSyncFeatureEnabled: () => true,
    }));
    vi.doMock("../../../src/gateway/services/cloudUploadMode.js", () => ({
      shouldAutoUploadReplicaSyncKey: () => true,
    }));
    vi.doMock("../../../src/gateway/services/tursoReplica/replicaPublishHold.js", () => ({
      isSyncKeyHeld: () => false,
    }));
    vi.doMock("../../../src/gateway/services/tursoReplica/tursoReplicaPushInteractiveDefer.js", () => ({
      shouldDeferReplicaPushWhileInteractive: () => false,
    }));
    vi.doMock("../../../src/gateway/services/gatewayBackgroundWork.js", () => ({
      yieldToInteractiveHotPath: async () => undefined,
    }));
    vi.doMock("../../../src/gateway/services/TursoSyncBridge.js", () => ({
      ensureTursoSyncBridge: () => ({
        enabled: true,
        getAppsRootDir: () => "/tmp/apps",
        listLinkedSources: async () => [],
      }),
    }));
    vi.doMock("../../../src/gateway/services/DatabaseRegistryService.js", () => ({
      initializeDatabaseRegistry: async () => undefined,
      getDatabaseRegistryService: () => ({
        getById: (id: string) => id === "db-loop"
          ? { dbId: "db-loop", localPath: "/tmp/loop/data.db", syncMode: "replica", createdAt: "2026-01-01" }
          : undefined,
        getByPath: () => undefined,
      }),
    }));
    vi.doMock("../../../src/gateway/services/tursoReplica/tursoReplicaRouting.js", () => ({
      pushLinkedDbViaTursoReplica: push,
      shouldUseTursoReplicaForSource: () => true,
      // pending never clears — the state that made one replica pull ~10 GB/hour
      syncStatusForLinkedDb: async () => ({ pendingPush: true, lastPushError: null, migrationConflict: false }),
    }));

    const s = await import("../../../src/gateway/services/tursoReplica/tursoReplicaPushScheduler.js");
    s.scheduleTursoReplicaPushForSyncKey("db-loop", "normal", "manual");
    await new Promise((r) => setTimeout(r, 1500));
    // one check, no follow-ups and no failure-backoff retries
    expect(push).toHaveBeenCalledTimes(1);
    // a new write re-checks (not stuck in backoff)
    s.scheduleTursoReplicaPushForSyncKey("db-loop", "normal", "watcher");
    await new Promise((r) => setTimeout(r, 300));
    expect(push).toHaveBeenCalledTimes(2);
    s.resetTursoReplicaPushSchedulerForTests();
  });
});
