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

import { finalizeAppRepoMutation } from "../src/gateway/services/syncV3/finalizeAppRepoMutation.js";

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
});
