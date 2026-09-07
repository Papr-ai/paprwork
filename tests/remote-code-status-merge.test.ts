import { describe, expect, test } from "vitest";

import {
  mergeRemoteCodeCheckIntoStatus,
  suppressStaleGitUpdatesAvailable,
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
    hasLocalChanges: false,
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
    expect(merged.overall).toBe("synced");
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

  test("does not claim cloud is newer when local changes are waiting", () => {
    const localPending = baseStatus({
      overall: "needs_sync",
      codeStatus: "pending",
      codePhase: "changed",
      hasLocalChanges: true,
      chipLabel: "Not published",
      summaryLine: "Local changes waiting — manual publish mode (click Publish changes)",
    });
    const merged = mergeRemoteCodeCheckIntoStatus(localPending, {
      upToDate: false,
      remoteCommitSha: "abc123",
    });
    expect(merged.gitUpdatesAvailable).toBe(false);
    expect(merged.codeStatus).toBe("pending");
    expect(merged.summaryLine).toContain("Local changes waiting");
  });

  test("clears stale namespace-git flag when live remote check is up to date", () => {
    const merged = mergeRemoteCodeCheckIntoStatus(
      baseStatus({
        gitUpdatesAvailable: true,
        codeStatus: "updates_available",
        overall: "needs_sync",
        chipLabel: "Updates available",
      }),
      {
        upToDate: true,
        remoteCommitSha: "abc123",
      },
    );
    expect(merged.gitUpdatesAvailable).toBe(false);
    expect(merged.codeStatus).toBe("synced");
    expect(merged.overall).toBe("synced");
  });
});

describe("suppressStaleGitUpdatesAvailable", () => {
  test("hides cached flag while live check pending", () => {
    const pending = suppressStaleGitUpdatesAvailable(
      baseStatus({ gitUpdatesAvailable: true }),
      true,
    );
    expect(pending.gitUpdatesAvailable).toBe(false);

    const settled = suppressStaleGitUpdatesAvailable(
      baseStatus({ gitUpdatesAvailable: true }),
      false,
    );
    expect(settled.gitUpdatesAvailable).toBe(true);
  });
});
