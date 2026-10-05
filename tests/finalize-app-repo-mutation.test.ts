import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const mockPrepare = vi.fn();
const mockReconcileManifest = vi.fn();
const mockPushWriter = vi.fn();
const mockSyncPublishedAppCatalogLayer = vi.fn();

vi.mock("../src/gateway/services/cloudSync/prepareAppsForCloud.js", () => ({
  prepareAppForCloudGitSync: (...args: unknown[]) => mockPrepare(...args),
}));

vi.mock("../src/gateway/services/syncV3/platformCatalogManifest.js", () => ({
  reconcilePlatformCatalogManifest: (...args: unknown[]) =>
    mockReconcileManifest(...args),
}));

vi.mock("../src/gateway/services/syncV3/pushAppWriterOpsCore.js", () => ({
  pushAppWriterOpsForPaprDir: (...args: unknown[]) => mockPushWriter(...args),
}));

vi.mock("../src/gateway/services/syncV3/syncPublishedAppCatalogLayer.js", () => ({
  syncPublishedAppCatalogLayer: (...args: unknown[]) =>
    mockSyncPublishedAppCatalogLayer(...args),
}));

const mockSyncMetadataForFlush = vi.fn();

vi.mock("../src/gateway/services/syncV3/syncMetadataForFlush.js", () => ({
  syncMetadataToCloudForFlush: (...args: unknown[]) =>
    mockSyncMetadataForFlush(...args),
}));

const mockWorkerPush = vi.fn();
const mockFanout = vi.fn();
const mockMarkSynced = vi.fn();
let workerEnabled = false;

vi.mock("../src/gateway/services/publishWorker/PublishWorkerClient.js", async () => {
  class PublishWorkerRequestError extends Error {
    constructor(readonly detail: { name: string; message: string }) {
      super(detail.message);
      this.name = detail.name;
    }
  }
  return {
    isPublishWorkerEnabled: () => workerEnabled,
    getPublishWorkerClient: () => ({ push: (...a: unknown[]) => mockWorkerPush(...a) }),
    PublishWorkerRequestError,
  };
});

vi.mock("../src/gateway/utils/keyResolver.js", () => ({
  getPaprApiKey: async () => "papr-key",
}));

vi.mock("../src/gateway/services/syncV3/appRepoCommittedFanout.js", () => ({
  fanoutAppRepoCommitted: (...args: unknown[]) => mockFanout(...args),
}));

const mockHeld = vi.fn(async () => [] as unknown[]);
const mockPublishHeld = vi.fn();
const mockSwitch = vi.fn();
vi.mock("../src/gateway/services/syncV3/publishHeldDatabasesForApp.js", () => ({
  heldDatabasesForApp: (...a: unknown[]) => mockHeld(...a),
  publishHeldDatabasesForApp: (...a: unknown[]) => mockPublishHeld(...a),
  switchHostToCommit: (...a: unknown[]) => mockSwitch(...a),
}));

import { finalizeAppRepoMutation } from "../src/gateway/services/syncV3/finalizeAppRepoMutation.js";
import { PublishWorkerRequestError } from "../src/gateway/services/publishWorker/PublishWorkerClient.js";
import { AppOpsConflictError } from "../src/gateway/services/syncV3/AppOpsClient.js";

describe("finalizeAppRepoMutation", () => {
  beforeEach(() => {
    mockPrepare.mockResolvedValue(undefined);
    mockReconcileManifest.mockResolvedValue({
      version: 1,
      platform: ["macos", "windows", "linux"],
      requiresDesktopForFullFunctionality: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    mockPushWriter.mockResolvedValue({
      appId: "app-1",
      filesSent: 2,
      skippedUnchanged: 0,
      outboxReplayed: 0,
      commitSha: "abc123",
    });
    mockSyncPublishedAppCatalogLayer.mockResolvedValue({
      catalogSynced: true,
    });
    mockSyncMetadataForFlush.mockResolvedValue({ warnings: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.CLOUD_CATALOG_LIGHT_SYNC;
  });

  it("runs prep → manifest → writer in order", async () => {
    const order: string[] = [];
    mockPrepare.mockImplementation(async () => {
      order.push("prep");
    });
    mockReconcileManifest.mockImplementation(async () => {
      order.push("manifest");
      return {
        version: 1,
        platform: ["macos"],
        requiresDesktopForFullFunctionality: false,
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
    });
    mockPushWriter.mockImplementation(async () => {
      order.push("writer");
      return { appId: "app-1", filesSent: 1, skippedUnchanged: 0, outboxReplayed: 0 };
    });

    await finalizeAppRepoMutation("/tmp/papr", "app-1", {
      source: "desktop-flush",
      skipCatalog: true,
    });

    expect(order).toEqual(["prep", "manifest", "writer"]);
    expect(mockSyncPublishedAppCatalogLayer).not.toHaveBeenCalled();
  });

  it("delegates catalog sync to syncPublishedAppCatalogLayer when enabled", async () => {
    const result = await finalizeAppRepoMutation("/tmp/papr", "app-1", {
      source: "cloud-sandbox",
    });

    expect(mockSyncPublishedAppCatalogLayer).toHaveBeenCalledWith("app-1", {
      afterWriterChange: true,
    });
    expect(result.catalogSynced).toBe(true);
    expect(result.writerPushed).toBe(true);
  });

  it("skips catalog when skipCatalog is set", async () => {
    await finalizeAppRepoMutation("/tmp/papr", "app-1", {
      source: "cloud-sandbox",
      skipCatalog: true,
    });

    expect(mockSyncPublishedAppCatalogLayer).not.toHaveBeenCalled();
  });

  it("preserves writer success when catalog sync fails", async () => {
    mockSyncPublishedAppCatalogLayer.mockResolvedValue({
      catalogSynced: false,
      catalogError: "memory 503",
    });

    const result = await finalizeAppRepoMutation("/tmp/papr", "app-1", {
      source: "desktop-flush",
    });

    expect(result.writerPushed).toBe(true);
    expect(result.commitSha).toBe("abc123");
    expect(result.catalogSynced).toBe(false);
    expect(result.catalogError).toBe("memory 503");
  });

  it("does not mark afterWriterChange when writer had no file changes", async () => {
    mockPushWriter.mockResolvedValue({
      appId: "app-1",
      filesSent: 0,
      skippedUnchanged: 2,
      outboxReplayed: 0,
    });

    await finalizeAppRepoMutation("/tmp/papr", "app-1", {
      source: "cloud-sandbox",
    });

    expect(mockSyncPublishedAppCatalogLayer).toHaveBeenCalledWith("app-1", {
      afterWriterChange: false,
    });
  });

  describe("publish worker path", () => {
    const sync = { markRelativePathSynced: (p: string) => mockMarkSynced(p) } as never;
    beforeEach(() => {
      workerEnabled = true;
    });
    afterEach(() => {
      workerEnabled = false;
    });

    it("uploads in the worker, then marks synced + fans out in the gateway", async () => {
      mockWorkerPush.mockResolvedValue({
        result: { appId: "app-1", commitSha: "sha1", filesSent: 1, skippedUnchanged: 0, outboxReplayed: 0, deferred: 0 },
        syncedPaths: ["apps/app-1/index.html"],
        committed: [{ appId: "app-1", commitSha: "sha1" }],
        ownCommits: ["sha0-replayed", "sha1"],
      });
      const result = await finalizeAppRepoMutation("/papr", "app-1", {
        source: "desktop-flush",
        sync,
        skipCatalog: true,
      });
      expect(mockPushWriter).not.toHaveBeenCalled();
      expect(mockWorkerPush.mock.calls[0]![0]).toMatchObject({ appId: "app-1", paprDir: "/papr", apiKey: "papr-key" });
      expect(mockMarkSynced).toHaveBeenCalledWith("apps/app-1/index.html");
      expect(mockFanout).toHaveBeenCalledWith({ appId: "app-1", commitSha: "sha1" });
      expect(result.commitSha).toBe("sha1");
      // Regression: the worker records own commits in ITS memory; without this the
      // gateway pulls its own publish back as a "remote update".
      const { isOwnAppCommit } = await import("../src/gateway/services/syncV3/appRepoPendingUpdate.js");
      expect(isOwnAppCommit("app-1", "sha1")).toBe(true);
      expect(isOwnAppCommit("app-1", "sha0-replayed")).toBe(true);
    });

    it("rethrows worker conflicts as AppOpsConflictError", async () => {
      mockWorkerPush.mockRejectedValue(
        new PublishWorkerRequestError({
          name: "AppOpsConflictError",
          message: "Writer conflict",
          appId: "app-1",
          artifacts: [{ path: "index.html", expectedParentHash: "a", actualBlobOid: "b" }],
        } as never),
      );
      await expect(
        finalizeAppRepoMutation("/papr", "app-1", { source: "desktop-flush", sync, skipCatalog: true }),
      ).rejects.toBeInstanceOf(AppOpsConflictError);
    });

    it("cloud sandbox never uses the worker", async () => {
      await finalizeAppRepoMutation("/papr", "app-1", { source: "cloud-sandbox", skipCatalog: true });
      expect(mockWorkerPush).not.toHaveBeenCalled();
      expect(mockPushWriter).toHaveBeenCalled();
    });
  });
});

describe("finalizeAppRepoMutation with a held database (option A)", () => {
  const order: string[] = [];
  beforeEach(() => {
    order.length = 0;
    workerEnabled = false;
    mockHeld.mockReset();
    mockPublishHeld.mockReset();
    mockSwitch.mockReset();
    mockPushWriter.mockReset();
    mockSyncMetadataForFlush.mockReset();
    mockSyncMetadataForFlush.mockResolvedValue({ warnings: [] });
    mockPushWriter.mockImplementation(async () => {
      order.push("code");
      return { filesSent: 1, commitSha: "a".repeat(40), outboxReplayed: 0, deferred: 0 };
    });
    mockPublishHeld.mockImplementation(async () => {
      order.push("db");
      return [{ dbId: "db-1", migrated: ["0002"], replayed: 0 }];
    });
    mockSwitch.mockImplementation(async () => {
      order.push("switch");
    });
  });

  it("background upload skips the app's code while a database is held", async () => {
    mockHeld.mockResolvedValue([{ dbId: "db-1" }]);
    const r = await finalizeAppRepoMutation("/papr", "app-1", { source: "cloud-sandbox", skipCatalog: true });
    expect(r.heldForPublish).toBe(true);
    expect(r.writerPushed).toBe(false);
    expect(order).toEqual([]);
  });

  it("publish runs database first, then code, then switches the host", async () => {
    mockHeld.mockResolvedValue([{ dbId: "db-1" }]);
    const r = await finalizeAppRepoMutation("/papr", "app-1", { source: "desktop-flush", skipCatalog: true });
    expect(order).toEqual(["db", "code", "switch"]);
    expect(r.heldDatabases).toHaveLength(1);
  });

  it("a failed database step pushes no code", async () => {
    mockHeld.mockResolvedValue([{ dbId: "db-1" }]);
    mockPublishHeld.mockRejectedValue(new Error("verify failed"));
    await expect(
      finalizeAppRepoMutation("/papr", "app-1", { source: "desktop-flush", skipCatalog: true }),
    ).rejects.toThrow(/verify failed/);
    expect(order).toEqual([]);
  });

  it("no hold: code only, no switch", async () => {
    mockHeld.mockResolvedValue([]);
    await finalizeAppRepoMutation("/papr", "app-1", { source: "cloud-sandbox", skipCatalog: true });
    expect(order).toEqual(["code"]);
  });
});
