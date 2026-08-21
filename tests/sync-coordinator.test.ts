import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CloudSyncService } from "../src/gateway/services/CloudSyncService.js";
import {
  initializeSyncCoordinator,
  getSyncCoordinator,
} from "../src/gateway/services/cloudSync/SyncCoordinator.js";

vi.mock("../src/gateway/services/cloudSync/flushAppNow.js", () => ({
  flushAppNow: vi.fn(async (_sync, appId: string) => ({
    appId,
    localMigrationsApplied: [],
    tursoPushed: true,
    webReady: true,
    published: true,
  })),
}));

vi.mock("../src/gateway/services/cloudUploadMode.js", () => ({
  shouldAutoUploadApp: vi.fn(() => true),
}));

vi.mock("../src/gateway/services/tursoPushScheduler.js", () => ({
  scheduleTursoPushForJob: vi.fn(),
}));

describe("SyncCoordinator", () => {
  const mockSync = {
    getPaprDir: () => "/tmp/papr-test",
    enqueueRelativePath: vi.fn(),
    hasRelativePathChanged: vi.fn(() => true),
    getManualFlushError: vi.fn(() => null),
    recordManualFlushError: vi.fn(),
    clearManualFlushError: vi.fn(),
    markRelativePathSynced: vi.fn(),
  } as unknown as CloudSyncService;

  beforeEach(() => {
    vi.clearAllMocks();
    initializeSyncCoordinator(mockSync);
  });

  it("coalesces concurrent flushNow calls for the same app", async () => {
    const coordinator = getSyncCoordinator();
    expect(coordinator).not.toBeNull();

    const { flushAppNow } = await import(
      "../src/gateway/services/cloudSync/flushAppNow.js"
    );

    const [a, b] = await Promise.all([
      coordinator!.flushNow("app-a"),
      coordinator!.flushNow("app-a"),
    ]);

    expect(a.appId).toBe("app-a");
    expect(b.appId).toBe("app-a");
    expect(flushAppNow).toHaveBeenCalledTimes(1);
  });

  it("serializes flushes for different apps (namespace queue)", async () => {
    const coordinator = getSyncCoordinator()!;
    const { flushAppNow } = await import(
      "../src/gateway/services/cloudSync/flushAppNow.js"
    );

    let active = 0;
    let maxActive = 0;
    vi.mocked(flushAppNow).mockImplementation(async (_sync, appId: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return {
        appId,
        localMigrationsApplied: [],
        tursoPushed: true,
        webReady: true,
        published: true,
      };
    });

    await Promise.all([
      coordinator.flushNow("app-a", { trigger: "auto" }),
      coordinator.flushNow("app-b", { trigger: "auto" }),
    ]);

    expect(flushAppNow).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });

  it("runs manual flush before a later queued auto flush", async () => {
    const coordinator = getSyncCoordinator()!;
    const { flushAppNow } = await import(
      "../src/gateway/services/cloudSync/flushAppNow.js"
    );

    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    vi.mocked(flushAppNow)
      .mockImplementationOnce(async () => {
        releaseFirst?.();
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 30);
        });
        order.push("slow-app");
        return {
          appId: "slow-app",
          localMigrationsApplied: [],
          tursoPushed: true,
          webReady: true,
          published: true,
        };
      })
      .mockImplementation(async (_sync, appId: string) => {
        order.push(appId);
        return {
          appId,
          localMigrationsApplied: [],
          tursoPushed: true,
          webReady: true,
          published: true,
        };
      });

    const slow = coordinator.flushNow("slow-app", { trigger: "auto" });
    await firstStarted;
    const manual = coordinator.flushNow("fast-app", { trigger: "manual" });
    const queuedAuto = coordinator.flushNow("queued-app", { trigger: "auto" });
    await Promise.all([slow, manual, queuedAuto]);

    expect(order).toEqual(["slow-app", "fast-app", "queued-app"]);
  });

  it("resolves auto flush failures without rejecting (no unhandled rejection)", async () => {
    const coordinator = getSyncCoordinator()!;
    const { flushAppNow } = await import(
      "../src/gateway/services/cloudSync/flushAppNow.js"
    );

    vi.mocked(flushAppNow).mockRejectedValueOnce(
      new Error("Turso verify failed for app-a: Turso: model: status empty"),
    );

    const result = await coordinator.flushNow("app-a", { trigger: "auto" });
    expect(result.webReady).toBe(false);
    expect(result.tursoPushed).toBe(false);
    expect(coordinator.getFlushError("app-a")?.retryPending).toBe(true);
  });

  it("markGitDirty schedules ordered flush for auto-upload apps", async () => {
    vi.useFakeTimers();
    const coordinator = getSyncCoordinator()!;
    coordinator.markGitDirty("apps/my-app");

    expect(mockSync.enqueueRelativePath).not.toHaveBeenCalled();

    const { flushAppNow } = await import(
      "../src/gateway/services/cloudSync/flushAppNow.js"
    );

    await vi.advanceTimersByTimeAsync(35_000);
    expect(flushAppNow).toHaveBeenCalledWith(
      mockSync,
      "my-app",
      expect.objectContaining({ skipTursoReschedule: true }),
    );
    vi.useRealTimers();
  });

  it("markDbDirty sets dirty flag and schedules Turso push", async () => {
    const { scheduleTursoPushForJob } = await import(
      "../src/gateway/services/tursoPushScheduler.js"
    );
    const bridgeCore = await import("../src/gateway/services/tursoSyncBridgeCore.js");
    const syncState = await import("../src/gateway/services/tursoSyncState.js");

    vi.spyOn(bridgeCore, "localDbHasSyncableUserTables").mockReturnValue(true);
    vi.spyOn(syncState, "hasUnpushedLocalDbChanges").mockReturnValue(true);
    const markSpy = vi.spyOn(syncState, "markDbDirty");

    const coordinator = getSyncCoordinator()!;
    coordinator.markDbDirty("db-key", "/tmp/data.db", "watcher");

    expect(markSpy).toHaveBeenCalledWith("db-key", "/tmp/data.db", "/tmp/papr-test");
    expect(scheduleTursoPushForJob).toHaveBeenCalledWith(
      "db-key",
      "normal",
      "watcher",
    );

    vi.restoreAllMocks();
  });

  it("markDbDirty skips schedule when content is already synced", async () => {
    const { scheduleTursoPushForJob } = await import(
      "../src/gateway/services/tursoPushScheduler.js"
    );
    const bridgeCore = await import("../src/gateway/services/tursoSyncBridgeCore.js");
    const syncState = await import("../src/gateway/services/tursoSyncState.js");

    vi.spyOn(bridgeCore, "localDbHasSyncableUserTables").mockReturnValue(true);
    vi.spyOn(syncState, "hasUnpushedLocalDbChanges").mockReturnValue(false);
    const markSpy = vi.spyOn(syncState, "markDbDirty");
    const clearSpy = vi.spyOn(syncState, "clearStaleDirtyFlagIfClean");

    const coordinator = getSyncCoordinator()!;
    coordinator.markDbDirty("db-key", "/tmp/data.db", "watcher");

    expect(clearSpy).toHaveBeenCalledWith("db-key", "/tmp/data.db", "/tmp/papr-test");
    expect(markSpy).not.toHaveBeenCalled();
    expect(scheduleTursoPushForJob).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it("clears active flush and busy file when upload is skipped as up to date", async () => {
    vi.mocked(mockSync.hasRelativePathChanged).mockReturnValueOnce(false);
    const pending = await import(
      "../src/gateway/services/cloudSync/pendingLocalUploads.js"
    );
    const webReadyMod = await import(
      "../src/gateway/services/cloudSync/webReady.js"
    );
    const { flushAppNow } = await import(
      "../src/gateway/services/cloudSync/flushAppNow.js"
    );
    const { readGatewaySyncBusyState } = await import(
      "../src/gateway/services/cloudSync/syncBusyState.js"
    );

    const asyncSpy = vi
      .spyOn(pending, "appNeedsOrderedFlushAsync")
      .mockResolvedValueOnce(false);
    const webSpy = vi
      .spyOn(webReadyMod, "webReady")
      .mockResolvedValueOnce({ ready: true });

    const coordinator = getSyncCoordinator()!;
    const result = await coordinator.flushNow("skip-app", { trigger: "manual" });

    expect(result.webReady).toBe(true);
    expect(flushAppNow).not.toHaveBeenCalled();
    expect(coordinator.getStatus().activeFlush).toBeNull();
    expect(readGatewaySyncBusyState("/tmp/papr-test")).toBeNull();

    asyncSpy.mockRestore();
    webSpy.mockRestore();
  });

  it("runs flush when schema drift exists even if git/db flags are clean", async () => {
    vi.mocked(mockSync.hasRelativePathChanged).mockReturnValueOnce(false);
    const pending = await import(
      "../src/gateway/services/cloudSync/pendingLocalUploads.js"
    );
    const { flushAppNow } = await import(
      "../src/gateway/services/cloudSync/flushAppNow.js"
    );

    const asyncSpy = vi
      .spyOn(pending, "appNeedsOrderedFlushAsync")
      .mockResolvedValueOnce(true);

    const coordinator = getSyncCoordinator()!;
    await coordinator.flushNow("drift-app", { trigger: "manual" });

    expect(flushAppNow).toHaveBeenCalledWith(
      mockSync,
      "drift-app",
      expect.objectContaining({ skipTursoReschedule: true }),
    );

    asyncSpy.mockRestore();
  });
});
