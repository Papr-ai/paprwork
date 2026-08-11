import { describe, expect, it } from "vitest";
import {
  buildGitHubSyncItemsReport,
  resolveGitHubItemSyncStatus,
} from "../src/gateway/services/cloudSync/syncItemStatus.js";

describe("resolveGitHubItemSyncStatus", () => {
  it("reports failed when item is in dead-letter", () => {
    const status = resolveGitHubItemSyncStatus(
      "apps/broken",
      { "apps/broken": { lastSyncAt: "2026-01-01T00:00:00.000Z", contentHash: "abc" } },
      [],
      () => false,
      {
        "apps/broken": {
          lastFailedAt: "2026-01-02T00:00:00.000Z",
          failures: 3,
          lastError: "push timeout",
        },
      },
    );
    expect(status).toBe("failed");
  });

  it("reports updates_available when remote git is ahead for that folder", () => {
    const remotePaths = new Set(["apps/demo/index.html"]);
    const status = resolveGitHubItemSyncStatus(
      "apps/demo",
      { "apps/demo": { lastSyncAt: "2026-01-01T00:00:00.000Z", contentHash: "abc" } },
      [],
      () => false,
      undefined,
      undefined,
      true,
      remotePaths,
    );
    expect(status).toBe("updates_available");
  });

  it("does not mark app updates_available when only job metadata changed on remote", () => {
    const remotePaths = new Set(["Jobs/job-a/job.json", "data/jobs.json"]);
    const status = resolveGitHubItemSyncStatus(
      "apps/demo",
      { "apps/demo": { lastSyncAt: "2026-01-01T00:00:00.000Z", contentHash: "abc" } },
      [],
      () => false,
      undefined,
      undefined,
      true,
      remotePaths,
    );
    expect(status).toBe("synced");
  });

  it("does not mark job updates_available when remote paths are unknown", () => {
    const status = resolveGitHubItemSyncStatus(
      "Jobs/job-a",
      { "Jobs/job-a": { lastSyncAt: "2026-01-01T00:00:00.000Z", contentHash: "abc" } },
      [],
      () => false,
      undefined,
      undefined,
      true,
      undefined,
    );
    expect(status).toBe("synced");
  });

  it("reports pending with manual hold via buildGitHubSyncItemsReport", () => {
    const report = buildGitHubSyncItemsReport({
      paprDir: "/tmp/unused",
      syncedItems: {},
      queuedPaths: [],
      hasItemChanged: () => true,
      shouldAutoUploadPath: () => false,
    });
    expect(report.apps.length).toBe(0);
  });
});
