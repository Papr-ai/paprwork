import { describe, expect, it, vi, beforeEach } from "vitest";

const mockGetCloudPublishStatus = vi.fn();
const mockSyncLiveAppArtifacts = vi.fn();
const mockSyncCatalogIfDrift = vi.fn();
const mockUpdateCatalogMetadata = vi.fn();

vi.mock("../src/gateway/services/CloudAppPublishService.js", () => ({
  getCloudAppPublishService: () => ({
    getCloudPublishStatus: (...args: unknown[]) =>
      mockGetCloudPublishStatus(...args),
    syncLiveAppArtifacts: (...args: unknown[]) =>
      mockSyncLiveAppArtifacts(...args),
    syncCatalogIfDrift: (...args: unknown[]) => mockSyncCatalogIfDrift(...args),
    updateCatalogMetadata: (...args: unknown[]) =>
      mockUpdateCatalogMetadata(...args),
  }),
}));

import { syncPublishedAppCatalogLayer } from "../src/gateway/services/syncV3/syncPublishedAppCatalogLayer.js";

describe("syncPublishedAppCatalogLayer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCloudPublishStatus.mockResolvedValue({
      published: true,
      shareUrl: "https://apps.papr.ai/ns/app-1",
    });
    mockSyncLiveAppArtifacts.mockResolvedValue(undefined);
    mockSyncCatalogIfDrift.mockResolvedValue(null);
    mockUpdateCatalogMetadata.mockResolvedValue({
      appId: "app-1",
      enabled: true,
    });
  });

  it("skips unpublished apps", async () => {
    mockGetCloudPublishStatus.mockResolvedValue({ published: false, shareUrl: null });

    const result = await syncPublishedAppCatalogLayer("app-1");

    expect(result.catalogSynced).toBe(false);
    expect(mockSyncLiveAppArtifacts).not.toHaveBeenCalled();
  });

  it("uses drift repair by default under light sync", async () => {
    mockSyncCatalogIfDrift.mockResolvedValue({ appId: "app-1", enabled: true });

    const result = await syncPublishedAppCatalogLayer("app-1");

    expect(mockSyncLiveAppArtifacts).toHaveBeenCalledWith("app-1");
    expect(mockSyncCatalogIfDrift).toHaveBeenCalledWith("app-1");
    expect(mockUpdateCatalogMetadata).not.toHaveBeenCalled();
    expect(result.catalogSynced).toBe(true);
  });

  it("forces catalog metadata refresh after writer change", async () => {
    const result = await syncPublishedAppCatalogLayer("app-1", {
      afterWriterChange: true,
    });

    expect(mockUpdateCatalogMetadata).toHaveBeenCalledWith("app-1", {
      preserveCloudSharing: true,
    });
    expect(mockSyncCatalogIfDrift).not.toHaveBeenCalled();
    expect(result.catalogSynced).toBe(true);
  });

  it("always syncs live app artifacts before drift repair", async () => {
    mockSyncCatalogIfDrift.mockResolvedValue({ appId: "app-1", enabled: true });

    const result = await syncPublishedAppCatalogLayer("app-1");

    expect(mockSyncLiveAppArtifacts).toHaveBeenCalledWith("app-1");
    expect(mockSyncCatalogIfDrift).toHaveBeenCalledWith("app-1");
    expect(result.catalogSynced).toBe(true);
  });
});
