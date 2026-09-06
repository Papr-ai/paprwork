import { describe, expect, test } from "vitest";

import {
  mergeRemoteCodeCheckIntoStatus,
  type AppCloudSyncStatus,
} from "../ui/utils/appCloudSyncStatus";

function baseStatus(overrides: Partial<AppCloudSyncStatus> = {}): AppCloudSyncStatus {
  return {
    appId: "app-1",
    overall: "synced",
    codeStatus: "synced",
    chipLabel: "Synced",
    summaryLine: "Everything matches the web.",
    gitUpdatesAvailable: false,
    gitUpdatesSummary: null,
    writerConflict: false,
    gitRemoteRequiresReview: false,
    gitRemoteMetadataSync: false,
    gitRemoteReviewHeadline: null,
    publishStatus: "live",
    publishLabel: "Live",
    publishDetail: null,
    publishLive: true,
    databases: [],
    registryPhase: "idle",
    registryLabel: "Ready",
    globallySyncing: false,
    cloudUploading: false,
    codeLastError: null,
    oversizedAppFilesMessage: null,
    oversizedAppFilesCount: 0,
    hasSchemaDrift: false,
    ...overrides,
  };
}

describe("mergeRemoteCodeCheckIntoStatus", () => {
  test("marks synced app as updates available when cloud is ahead", () => {
    const merged = mergeRemoteCodeCheckIntoStatus(baseStatus(), {
      upToDate: false,
      remoteCommitSha: "abc123",
    });
    expect(merged.gitUpdatesAvailable).toBe(true);
    expect(merged.codeStatus).toBe("updates_available");
    expect(merged.overall).toBe("needs_sync");
    expect(merged.chipLabel).toBe("Updates available");
  });

  test("leaves status unchanged when remote check says up to date", () => {
    const status = baseStatus();
    const merged = mergeRemoteCodeCheckIntoStatus(status, {
      upToDate: true,
      remoteCommitSha: "abc123",
    });
    expect(merged).toEqual(status);
  });

  test("does not override merge-review or writer conflict states", () => {
    const conflict = baseStatus({
      gitRemoteRequiresReview: true,
      overall: "needs_sync",
    });
    const merged = mergeRemoteCodeCheckIntoStatus(conflict, {
      upToDate: false,
    });
    expect(merged.gitUpdatesAvailable).toBe(false);
    expect(merged.chipLabel).toBe("Synced");
  });
});
