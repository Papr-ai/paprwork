import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { CloudSyncService } from "../src/gateway/services/CloudSyncService.js";

const mockApplyLocalMigrations = vi.fn();
const mockCatchUpLinkedSource = vi.fn();
const mockPushJob = vi.fn();
const mockWebReady = vi.fn();
const mockDiscoverTursoLinkedSources = vi.fn();
const mockIsLegacyWorkspaceRowSyncEnabled = vi.fn(() => true);

vi.mock("../src/gateway/services/TursoSyncBridge.js", () => ({
  ensureTursoSyncBridge: () => ({
    enabled: true,
    pushJob: (...args: unknown[]) => mockPushJob(...args),
  }),
}));

vi.mock("../src/gateway/services/cloudSync/applyLocalMigrationsForApp.js", () => ({
  applyLocalMigrationsForApp: (...args: unknown[]) =>
    mockApplyLocalMigrations(...args),
}));

vi.mock("../src/gateway/services/tursoLinkedSources.js", () => ({
  discoverTursoLinkedSources: (...args: unknown[]) =>
    mockDiscoverTursoLinkedSources(...args),
  linkedSourceSyncKey: () => "job-1",
  dedupeLinkedSourcesBySyncKey: (sources: unknown[]) => sources,
  linkedSourceAsAppDataSource: (source: unknown) => source,
}));

vi.mock("../src/gateway/services/tursoPushScheduler.js", () => ({
  cancelScheduledTursoPushForSyncKeys: vi.fn(),
  awaitTursoPushInFlightForSyncKeys: vi.fn().mockResolvedValue(undefined),
  withTursoPushInFlight: (_keys: unknown, operation: () => Promise<unknown>) =>
    operation(),
}));

vi.mock("../src/gateway/utils/tursoReplicaEnabled.js", () => ({
  isLegacyWorkspaceRowSyncEnabled: () => mockIsLegacyWorkspaceRowSyncEnabled(),
}));

vi.mock("../src/gateway/services/syncV3/workspaceLogSync.js", () => ({
  catchUpLinkedSourceFromWorkspaceLog: (...args: unknown[]) =>
    mockCatchUpLinkedSource(...args),
}));

vi.mock("../src/gateway/services/cloudSync/webReady.js", () => ({
  webReady: (...args: unknown[]) => mockWebReady(...args),
}));

const mockFinalizeAppRepoMutation = vi.fn();
const mockSyncPublishedAppCatalogLayer = vi.fn();

vi.mock("../src/gateway/services/syncV3/finalizeAppRepoMutation.js", () => ({
  finalizeAppRepoMutation: (...args: unknown[]) =>
    mockFinalizeAppRepoMutation(...args),
}));

vi.mock("../src/gateway/services/syncV3/syncPublishedAppCatalogLayer.js", () => ({
  syncPublishedAppCatalogLayer: (...args: unknown[]) =>
    mockSyncPublishedAppCatalogLayer(...args),
}));

const mockPushLinkedSource = vi.fn();
const mockShouldSkipTursoPush = vi.fn();
const mockShouldUseTursoReplicaForSource = vi.fn(() => true);
const mockRunReplicaCutoverForAppUpload = vi.fn();

vi.mock(
  "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverOrchestrator.js",
  () => ({
    runReplicaCutoverForAppUpload: (...args: unknown[]) =>
      mockRunReplicaCutoverForAppUpload(...args),
    formatReplicaCutoverUploadFailure: (batch: {
      results: Array<{ ok: boolean; skipped?: boolean }>;
    }) => {
      const failed = batch.results.filter(
        (result) => !result.ok && !result.skipped,
      );
      return failed.length > 0 ? "Replica cutover failed — db-1: blocked" : null;
    },
  }),
);

vi.mock("../src/gateway/services/tursoReplica/tursoReplicaRouting.js", () => ({
  pushLinkedSourceWithReplicaRouting: (...args: unknown[]) =>
    mockPushLinkedSource(...args),
  shouldSkipTursoPushInFlushForReplicaSource: (...args: unknown[]) =>
    mockShouldSkipTursoPush(...args),
  shouldUseTursoReplicaForSource: (...args: unknown[]) =>
    mockShouldUseTursoReplicaForSource(...args),
}));

import { flushAppNow } from "../src/gateway/services/cloudSync/flushAppNow.js";

describe("flushAppNow", () => {
  const sync = {
    getPaprDir: () => "/tmp/papr",
    markAppForPostFlushHooks: vi.fn(),
    runPostFlushHooks: vi.fn().mockResolvedValue(undefined),
  } as unknown as CloudSyncService;

  const linkedSource = {
    appId: "app-1",
    jobId: "job-1",
    dbPath: "/tmp/papr/Jobs/job-1/data/data.db",
    alias: "main",
  };

  beforeEach(() => {
    mockIsLegacyWorkspaceRowSyncEnabled.mockReturnValue(true);
    mockShouldUseTursoReplicaForSource.mockReturnValue(true);
    mockRunReplicaCutoverForAppUpload.mockResolvedValue({
      dryRun: false,
      results: [],
      attempted: 0,
      succeeded: 0,
      blocked: 0,
      skipped: 0,
    });
    mockApplyLocalMigrations.mockResolvedValue([]);
    mockDiscoverTursoLinkedSources.mockResolvedValue([linkedSource]);
    mockCatchUpLinkedSource.mockResolvedValue(0);
    mockShouldSkipTursoPush.mockResolvedValue(false);
    mockPushLinkedSource.mockResolvedValue({
      syncKey: "job-1",
      alias: "main",
      appId: "app-1",
      backend: "legacy",
      ok: true,
    });
    mockPushJob.mockResolvedValue({
      status: "pushed",
      tables: ["*"],
      lastPushedLogId: 3,
    });
    mockFinalizeAppRepoMutation.mockResolvedValue({
      appId: "app-1",
      writerPushed: true,
      catalogSynced: false,
    });
    mockSyncPublishedAppCatalogLayer.mockResolvedValue({ catalogSynced: true });
    mockWebReady.mockResolvedValue({ ready: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("runs log catch-up before push, then catch-up again before writer ops", async () => {
    const callOrder: string[] = [];
    mockCatchUpLinkedSource.mockImplementation(async () => {
      callOrder.push("log-catch-up");
      return 0;
    });
    mockPushLinkedSource.mockImplementation(async () => {
      callOrder.push("turso-push");
      return {
        syncKey: "job-1",
        alias: "main",
        appId: "app-1",
        backend: "legacy",
        ok: true,
      };
    });
    mockFinalizeAppRepoMutation.mockImplementation(async () => {
      callOrder.push("writer");
      return {
        appId: "app-1",
        writerPushed: true,
        catalogSynced: false,
      };
    });
    mockSyncPublishedAppCatalogLayer.mockImplementation(async () => {
      callOrder.push("catalog");
      return { catalogSynced: true };
    });

    await flushAppNow(sync, "app-1");

    expect(callOrder).toEqual([
      "log-catch-up",
      "turso-push",
      "log-catch-up",
      "writer",
      "catalog",
    ]);
    expect(mockCatchUpLinkedSource).toHaveBeenCalledTimes(2);
    expect(mockFinalizeAppRepoMutation).toHaveBeenCalledWith(
      "/tmp/papr",
      "app-1",
      expect.objectContaining({
        source: "desktop-flush",
        sync,
        skipCatalog: true,
      }),
    );
    expect(mockSyncPublishedAppCatalogLayer).toHaveBeenCalledWith("app-1", {
      afterWriterChange: true,
    });
    expect(sync.runPostFlushHooks).toHaveBeenCalled();
  });

  it("does not publish when not web-ready", async () => {
    mockWebReady.mockResolvedValue({
      ready: false,
      reason: "turso_pending",
      detail: "main: pending",
    });

    const result = await flushAppNow(sync, "app-1");

    expect(result.webReady).toBe(false);
    expect(result.published).toBe(false);
    expect(sync.runPostFlushHooks).not.toHaveBeenCalled();
    expect(mockSyncPublishedAppCatalogLayer).not.toHaveBeenCalled();
  });

  it("does not mark published when catalog sync returns an error", async () => {
    mockSyncPublishedAppCatalogLayer.mockResolvedValue({
      catalogSynced: false,
      catalogError: "memory 503",
    });

    const result = await flushAppNow(sync, "app-1");

    expect(result.webReady).toBe(true);
    expect(result.published).toBe(false);
    expect(result.catalogError).toBe("memory 503");
    expect(sync.runPostFlushHooks).not.toHaveBeenCalled();
  });

  it("passes afterWriterChange=false when writer had no file changes", async () => {
    mockFinalizeAppRepoMutation.mockResolvedValue({
      appId: "app-1",
      writerPushed: false,
      catalogSynced: false,
    });

    await flushAppNow(sync, "app-1");

    expect(mockSyncPublishedAppCatalogLayer).toHaveBeenCalledWith("app-1", {
      afterWriterChange: false,
    });
  });

  it("skips Turso push when replica source is already auto-synced", async () => {
    mockShouldSkipTursoPush.mockResolvedValue(true);

    const result = await flushAppNow(sync, "app-1");

    expect(mockPushLinkedSource).not.toHaveBeenCalled();
    expect(result.tursoPushed).toBe(false);
  });

  it("Plan A flush runs cutover then pushes pending replica DBs then git", async () => {
    mockIsLegacyWorkspaceRowSyncEnabled.mockReturnValue(false);
    mockShouldSkipTursoPush.mockResolvedValue(false);
    const callOrder: string[] = [];
    mockRunReplicaCutoverForAppUpload.mockImplementation(async () => {
      callOrder.push("cutover");
      return {
        dryRun: false,
        results: [{ dbId: "db-1", ok: true, dryRun: false, classification: {} }],
        attempted: 1,
        succeeded: 1,
        blocked: 0,
        skipped: 0,
      };
    });
    mockApplyLocalMigrations.mockImplementation(async () => {
      callOrder.push("migrations");
      return [];
    });
    mockCatchUpLinkedSource.mockImplementation(async () => {
      callOrder.push("log-catch-up");
      return 0;
    });
    mockPushLinkedSource.mockImplementation(async () => {
      callOrder.push("turso-push");
      return {
        syncKey: "job-1",
        alias: "main",
        appId: "app-1",
        backend: "replica",
        ok: true,
      };
    });
    mockFinalizeAppRepoMutation.mockImplementation(async () => {
      callOrder.push("writer");
      return {
        appId: "app-1",
        writerPushed: true,
        catalogSynced: false,
      };
    });
    mockSyncPublishedAppCatalogLayer.mockImplementation(async () => {
      callOrder.push("catalog");
      return { catalogSynced: true };
    });

    const result = await flushAppNow(sync, "app-1");

    expect(callOrder).toEqual(["migrations", "cutover", "turso-push", "writer", "catalog"]);
    expect(mockRunReplicaCutoverForAppUpload).toHaveBeenCalledWith("app-1");
    expect(mockCatchUpLinkedSource).not.toHaveBeenCalled();
    expect(mockApplyLocalMigrations).toHaveBeenCalledWith("app-1", "/tmp/papr/apps");
    expect(mockPushLinkedSource).toHaveBeenCalledOnce();
    expect(result.tursoPushed).toBe(true);
    expect(result.published).toBe(true);
  });

  it("Plan A flush fails when cutover is blocked", async () => {
    mockIsLegacyWorkspaceRowSyncEnabled.mockReturnValue(false);
    mockRunReplicaCutoverForAppUpload.mockResolvedValue({
      dryRun: false,
      results: [
        {
          dbId: "db-1",
          ok: false,
          blocked: true,
          skipped: false,
          dryRun: false,
          error: "schema drift",
          classification: {},
        },
      ],
      attempted: 1,
      succeeded: 0,
      blocked: 1,
      skipped: 0,
    });

    await expect(flushAppNow(sync, "app-1")).rejects.toThrow(
      /Replica cutover failed/,
    );
    expect(mockPushLinkedSource).not.toHaveBeenCalled();
  });

  it("Plan A flush skips replica push when already auto-synced", async () => {
    mockIsLegacyWorkspaceRowSyncEnabled.mockReturnValue(false);
    mockShouldSkipTursoPush.mockResolvedValue(true);

    const result = await flushAppNow(sync, "app-1");

    expect(mockPushLinkedSource).not.toHaveBeenCalled();
    expect(result.tursoPushed).toBe(false);
  });
});
