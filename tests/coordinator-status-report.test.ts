import { describe, expect, it, vi } from "vitest";
import { buildCoordinatorStatusReport } from "../src/gateway/services/cloudSync/coordinatorStatusReport.js";
import { SyncCoordinator } from "../src/gateway/services/cloudSync/SyncCoordinator.js";
import type { CloudSyncService } from "../src/gateway/services/CloudSyncService.js";

describe("buildCoordinatorStatusReport", () => {
  it("returns uploading copy when flush is active", () => {
    const sync = {
      getPaprDir: () => "/tmp/papr",
      enqueueRelativePath: () => undefined,
      hasRelativePathChanged: () => false,
      markRelativePathSynced: () => undefined,
    } as unknown as CloudSyncService;

    const coordinator = new SyncCoordinator(sync);
    (coordinator as unknown as { activeProgress: { appId: string; startedAt: number } }).activeProgress =
      { appId: "app-1", startedAt: Date.now() };

    const report = buildCoordinatorStatusReport(coordinator, "app-1");
    expect(report?.status).toBe("uploading");
    expect(report?.label).toContain("Updating");
  });

  it("returns waiting copy when app has local changes", () => {
    const sync = {
      getPaprDir: () => "/tmp/papr",
      enqueueRelativePath: () => undefined,
      hasRelativePathChanged: () => false,
      markRelativePathSynced: () => undefined,
    } as unknown as CloudSyncService;

    const coordinator = new SyncCoordinator(sync);
    vi.spyOn(coordinator, "getStatus").mockReturnValue({
      activeFlush: null,
      gitDirtyAppIds: ["app-1"],
      dbDirtySyncKeys: [],
      inFlightAppIds: [],
      queuedFlushAppIds: [],
      flushErrors: {},
    });

    const report = buildCoordinatorStatusReport(coordinator, "app-1");
    expect(report?.status).toBe("waiting");
    expect(report?.label).toContain("waiting");
  });

  it("returns failed copy when flush error is exhausted", () => {
    const sync = {
      getPaprDir: () => "/tmp/papr",
      enqueueRelativePath: () => undefined,
      hasRelativePathChanged: () => false,
      markRelativePathSynced: () => undefined,
    } as unknown as CloudSyncService;

    const coordinator = new SyncCoordinator(sync);
    vi.spyOn(coordinator, "getStatus").mockReturnValue({
      activeFlush: null,
      gitDirtyAppIds: ["app-1"],
      dbDirtySyncKeys: [],
      inFlightAppIds: [],
      queuedFlushAppIds: [],
      flushErrors: {
        "app-1": {
          message: "Turso verify failed",
          at: new Date().toISOString(),
          retryPending: false,
        },
      },
    });

    const report = buildCoordinatorStatusReport(coordinator, "app-1");
    expect(report?.status).toBe("failed");
    expect(report?.label).toContain("Upload failed");
  });
});
