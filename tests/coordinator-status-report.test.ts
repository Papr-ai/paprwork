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

  it("returns idle when another app is actively flushing", () => {
    const sync = {
      getPaprDir: () => "/tmp/papr",
      enqueueRelativePath: () => undefined,
      hasRelativePathChanged: () => false,
      markRelativePathSynced: () => undefined,
    } as unknown as CloudSyncService;

    const coordinator = new SyncCoordinator(sync);
    (coordinator as unknown as { activeProgress: { appId: string; startedAt: number } }).activeProgress =
      { appId: "other-app", startedAt: Date.now() };

    const report = buildCoordinatorStatusReport(coordinator, "app-1");
    expect(report?.status).toBe("idle");
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

  it("does not report db waiting for another app's dirty database", () => {
    const sync = {
      getPaprDir: () => "/tmp/papr",
      enqueueRelativePath: () => undefined,
      hasRelativePathChanged: () => false,
      markRelativePathSynced: () => undefined,
    } as unknown as CloudSyncService;

    const coordinator = new SyncCoordinator(sync);
    vi.spyOn(coordinator, "getStatus").mockReturnValue({
      activeFlush: null,
      gitDirtyAppIds: [],
      dbDirtySyncKeys: [],
      inFlightAppIds: [],
      queuedFlushAppIds: [],
      flushErrors: {},
    });

    const report = buildCoordinatorStatusReport(coordinator, "app-1");
    expect(report?.status).toBe("idle");
  });

  it("returns waiting copy when app is queued with local work", () => {
    const sync = {
      getPaprDir: () => "/tmp/papr",
      enqueueRelativePath: () => undefined,
      hasRelativePathChanged: (relativePath: string) =>
        relativePath === "apps/app-1",
      markRelativePathSynced: () => undefined,
    } as unknown as CloudSyncService;

    const coordinator = new SyncCoordinator(sync);
    vi.spyOn(coordinator, "getStatus").mockReturnValue({
      activeFlush: null,
      gitDirtyAppIds: [],
      dbDirtySyncKeys: [],
      inFlightAppIds: [],
      queuedFlushAppIds: ["app-1"],
      flushErrors: {},
    });

    const report = buildCoordinatorStatusReport(coordinator, "app-1");
    expect(report?.status).toBe("waiting");
    expect(report?.label).toContain("Queued");
  });

  it("returns idle when app is queued but has no local flush work", () => {
    const sync = {
      getPaprDir: () => "/tmp/papr",
      enqueueRelativePath: () => undefined,
      hasRelativePathChanged: () => false,
      markRelativePathSynced: () => undefined,
    } as unknown as CloudSyncService;

    const coordinator = new SyncCoordinator(sync);
    vi.spyOn(coordinator, "getStatus").mockReturnValue({
      activeFlush: null,
      gitDirtyAppIds: [],
      dbDirtySyncKeys: [],
      inFlightAppIds: [],
      queuedFlushAppIds: ["app-1"],
      flushErrors: {},
    });

    const report = buildCoordinatorStatusReport(coordinator, "app-1");
    expect(report?.status).toBe("idle");
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

  it("returns queue position when app is queued behind an active flush", () => {
    const sync = {
      getPaprDir: () => "/tmp/papr",
      enqueueRelativePath: () => undefined,
      hasRelativePathChanged: (relativePath: string) =>
        relativePath === "apps/app-1",
      markRelativePathSynced: () => undefined,
    } as unknown as CloudSyncService;

    const coordinator = new SyncCoordinator(sync);
    (coordinator as unknown as { activeProgress: { appId: string; startedAt: number } }).activeProgress =
      { appId: "other-app", startedAt: Date.now() };
    vi.spyOn(coordinator, "getStatus").mockReturnValue({
      activeFlush: { appId: "other-app", layer: "git", startedAt: Date.now(), label: "Flush" },
      gitDirtyAppIds: [],
      dbDirtySyncKeys: [],
      inFlightAppIds: ["other-app"],
      queuedFlushAppIds: ["app-1", "app-2"],
      flushErrors: {},
    });

    const report = buildCoordinatorStatusReport(coordinator, "app-1");
    expect(report?.status).toBe("waiting");
    expect(report?.waitingReason).toBe("queued");
    expect(report?.queuePosition).toBe(2);
    expect(report?.queueDepth).toBe(3);
    expect(report?.label).toBe("1 app ahead · 3 in queue");
  });
});
