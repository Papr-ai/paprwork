import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { CloudSyncService } from "../src/gateway/services/CloudSyncService.js";

const mockApplyLocalMigrations = vi.fn();
const mockCatchUpLinkedSource = vi.fn();
const mockEnsureReplicaReady = vi.fn();
const mockPushJob = vi.fn();
const mockWebReady = vi.fn();
const mockDiscoverTursoLinkedSources = vi.fn();

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
}));

vi.mock("../src/gateway/services/tursoPushScheduler.js", () => ({
  cancelScheduledTursoPushForSyncKeys: vi.fn(),
  awaitTursoPushInFlightForSyncKeys: vi.fn().mockResolvedValue(undefined),
  withTursoPushInFlight: (_keys: unknown, operation: () => Promise<unknown>) =>
    operation(),
}));

vi.mock("../src/gateway/services/syncV3/ensureReplicaReady.js", () => ({
  ensureReplicaReady: (...args: unknown[]) => mockEnsureReplicaReady(...args),
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
    mockApplyLocalMigrations.mockResolvedValue([]);
    mockDiscoverTursoLinkedSources.mockResolvedValue([linkedSource]);
    mockCatchUpLinkedSource.mockResolvedValue(0);
    mockPushJob.mockResolvedValue({
      status: "pushed",
      tables: ["*"],
      lastPushedLogId: 3,
    });
    mockEnsureReplicaReady.mockResolvedValue({
      schemaShipped: 1,
      rowsShipped: 1,
      lastSyncLogId: 3,
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
    mockPushJob.mockImplementation(async () => {
      callOrder.push("turso-push");
      return { status: "pushed", tables: ["*"], lastPushedLogId: 3 };
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
});
