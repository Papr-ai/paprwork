import { describe, expect, it, vi, beforeEach } from "vitest";
import { SyncStateManager } from "../src/gateway/services/cloudSync/syncState.js";
import { buildAppSyncV3Report } from "../src/gateway/services/syncV3/appSyncV3StatusReport.js";

vi.mock("../src/gateway/services/syncV3/SyncOutbox.js", () => ({
  listOutboxEntries: vi.fn(async () => []),
  listPendingOutboxEntries: vi.fn(async () => []),
  listDeadLetterOutboxEntries: vi.fn(async () => []),
}));

vi.mock("../src/gateway/services/syncV3/writerConflict.js", () => ({
  listRecentWriterConflicts: vi.fn(() => []),
}));

vi.mock("../src/gateway/services/cloudUploadMode.js", () => ({
  shouldAutoUploadApp: vi.fn(() => true),
}));

import { listOutboxEntries } from "../src/gateway/services/syncV3/SyncOutbox.js";
import { listRecentWriterConflicts } from "../src/gateway/services/syncV3/writerConflict.js";

describe("buildAppSyncV3Report", () => {
  const paprDir = "/tmp/papr-sync-v3-status-test";
  let stateManager: SyncStateManager;

  beforeEach(() => {
    stateManager = new SyncStateManager(paprDir);
    stateManager.data.syncedItems = {};
    vi.mocked(listOutboxEntries).mockResolvedValue([]);
    vi.mocked(listRecentWriterConflicts).mockReturnValue([]);
  });

  it("reports uploading when coordinator is actively flushing", async () => {
    const report = await buildAppSyncV3Report({
      appId: "app-1",
      paprDir,
      stateManager,
      coordinatorUploading: true,
    });

    expect(report.status).toBe("uploading");
    expect(report.phase).toBe("uploading");
    expect(report.label).toBe("Uploading app code…");
  });

  it("reports pending when writer outbox has entries", async () => {
    vi.mocked(listOutboxEntries).mockResolvedValue([
      {
        id: "op-1",
        appId: "app-1",
        idempotencyKey: "k1",
        files: [],
        author: "test",
        message: "sync",
        status: "pending",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        attempts: 0,
      },
    ]);

    const report = await buildAppSyncV3Report({
      appId: "app-1",
      paprDir,
      stateManager,
    });

    expect(report.status).toBe("pending");
    expect(report.detail).toContain("1 writer change");
  });

  it("reports conflict when writer conflict events exist", async () => {
    vi.mocked(listRecentWriterConflicts).mockReturnValue([
      {
        appId: "app-1",
        path: "index.html",
        expectedParentHash: "abc",
        actualBlobOid: "def",
        at: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const report = await buildAppSyncV3Report({
      appId: "app-1",
      paprDir,
      stateManager,
    });

    expect(report.status).toBe("conflict");
    expect(report.label).toBe("Conflict on the web");
  });

  it("stays synced when queued behind other apps but already on the web", async () => {
    stateManager.data.syncedItems["apps/app-1"] = {
      lastSyncAt: "2026-08-19T16:27:15.989Z",
      contentHash: "missing",
    };

    const report = await buildAppSyncV3Report({
      appId: "app-1",
      paprDir,
      stateManager,
      coordinatorQueued: true,
      queuePosition: 2,
      queueDepth: 8,
    });

    expect(report.status).toBe("synced");
    expect(report.phase).toBe("synced");
    expect(report.label).toBe("App code on the web");
    expect(report.detail).not.toContain("queue");
  });
});
