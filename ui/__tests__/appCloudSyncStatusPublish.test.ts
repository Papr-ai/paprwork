/**
 * Web sync status for apps that have been uploaded but never published.
 *
 * Regression cover: clicking "Publish changes" on an unpublished (Draft · Private)
 * app left the indicator amber with "Some changes still need to sync to the
 * web", even though the upload had fully succeeded. publishLayerSynced
 * required publishLive, so a never-published app could never reach "synced".
 *
 * Upload = code in the private cloud repo. Publish = shared on the web.
 * They are separate actions, and upload must be able to complete on its own.
 */

import { describe, it, expect } from "vitest";
import {
  deriveAppCloudSyncStatus,
  formatWebSyncStatusTooltip,
  mergeRemoteCodeCheckIntoStatus,
  resolvePublishBarChipForForkUpstream,
  resolvePublishBarChipLabel,
  resolvePublishBarPrimaryAction,
  webSyncVisualState,
} from "../utils/appCloudSyncStatus";

const APP = "0a1ab32b-7c0c-4364-a98a-da637aa0dc70";

function items(over: {
  publishLive?: boolean;
  publishedAt?: string | null;
  publishStatus?: string;
  codeStatus?: string;
  codePhase?: string;
  hasLocalChanges?: boolean;
}): any {
  const codeStatus = over.codeStatus ?? "synced";
  const codePhase = over.codePhase ?? "synced";
  return {
    enabled: true,
    github: {
      workspace: [],
      apps: [
        {
          id: APP,
          kind: "app",
          label: "Papr Investor Update",
          relativePath: `apps/${APP}`,
          status: codeStatus,
          lastSyncAt: "2026-08-26T02:55:34.928Z",
          lastError: null,
          failedAt: null,
        },
      ],
      jobs: [],
      queuedPaths: [],
    },
    turso: { sources: [] },
    publish: { status: over.publishStatus ?? "synced" },
    upload: { status: "idle", label: "Nothing uploading right now" },
    appSync: {
      protocol: "v3",
      appId: APP,
      relativePath: `apps/${APP}`,
      status: codeStatus,
      phase: codePhase,
      label: "App code on the web",
      detail: "App files match the cloud repo",
      lastUploadedAt: "2026-08-26T02:55:34.928Z",
      lastError: null,
      manualUploadHold: false,
      pendingWriterOps: 0,
      inflightWriterOps: 0,
      deadLetterWriterOps: 0,
      hasLocalChanges: over.hasLocalChanges ?? false,
      queuedForUpload: false,
    },
    appContext: {
      appId: APP,
      dependentJobIds: [],
      registryDbIds: [],
      globalAutoUploadEnabled: false,
      publishLive: over.publishLive ?? false,
      publishedAt: over.publishedAt ?? null,
    },
    cached: false,
    uploadError: null,
  };
}

describe("upload vs publish", () => {
  it("reports synced after upload even when the app was never published", () => {
    const s = deriveAppCloudSyncStatus(APP, items({ publishLive: false }), "synced");

    expect(s.codePhase).toBe("synced");
    expect(s.overall).toBe("synced");
    expect(webSyncVisualState(s, {})).toBe("synced");
  });

  it("says uploaded but not shared, not 'changes still need to sync'", () => {
    const s = deriveAppCloudSyncStatus(APP, items({ publishLive: false }), "synced");

    expect(s.summaryLine).not.toContain("still need to sync");
    expect(s.summaryLine.toLowerCase()).toContain("not shared yet");
  });

  it("still reports synced for a published app with a healthy publish layer", () => {
    const s = deriveAppCloudSyncStatus(
      APP,
      items({ publishLive: true, publishedAt: "2026-08-26T02:00:00.000Z" }),
      "synced",
    );

    expect(s.overall).toBe("synced");
    expect(webSyncVisualState(s, {})).toBe("synced");
  });

  it("does NOT mask real local changes on an unpublished app", () => {
    const s = deriveAppCloudSyncStatus(
      APP,
      items({
        publishLive: false,
        codeStatus: "pending",
        codePhase: "changed",
        hasLocalChanges: true,
      }),
      "synced",
    );

    expect(s.overall).toBe("needs_sync");
    expect(webSyncVisualState(s, {})).not.toBe("synced");
  });

  it("does NOT mask publish drift on a published app", () => {
    const s = deriveAppCloudSyncStatus(
      APP,
      items({
        publishLive: true,
        publishedAt: "2026-08-26T02:00:00.000Z",
        publishStatus: "drift",
      }),
      "synced",
    );

    expect(s.overall).toBe("needs_sync");
  });
});

describe("v2 calm web sync (no default Checking)", () => {
  it("treats missing status as synced until the user checks", () => {
    expect(webSyncVisualState(null, {})).toBe("synced");
    const chip = resolvePublishBarChipLabel({
      state: "synced",
      live: true,
      syncEnabled: true,
      lastCheckedAt: null,
    });
    expect(chip.label).toBe("Live");
    expect(chip.label).not.toContain("Checking");
  });

  it("shows Checking only while a fetch is in flight", () => {
    expect(webSyncVisualState(null, { refreshing: true })).toBe("loading");
    expect(formatWebSyncStatusTooltip(null, { refreshing: true })).toContain(
      "Checking",
    );
    expect(formatWebSyncStatusTooltip(null, {})).not.toContain("Checking");
  });

  it("stays calm when hook loading is true but user has not refreshed yet", () => {
    expect(webSyncVisualState(null, { loading: true })).toBe("synced");
    const chip = resolvePublishBarChipLabel({
      state: webSyncVisualState(null, { loading: true }),
      live: true,
      syncEnabled: true,
      lastCheckedAt: null,
    });
    expect(chip.label).toBe("Live");
    expect(chip.label).not.toContain("Checking");
  });
});

describe("publish bar v2 chip labels", () => {
  it("shows Draft on an unpublished app with no API error", () => {
    const chip = resolvePublishBarChipLabel({
      state: "disabled",
      live: false,
      syncEnabled: true,
      lastCheckedAt: null,
    });
    expect(chip.label).toBe("Draft");
    expect(chip.tone).toBe("idle");
  });

  it("shows Last publish failed on draft when cloud publish API failed", () => {
    const chip = resolvePublishBarChipLabel({
      state: "disabled",
      live: false,
      syncEnabled: false,
      lastCheckedAt: null,
      cloudPublishFailed: true,
    });
    expect(chip.label).toBe("Last publish failed");
    expect(chip.tone).toBe("bad");
  });

  it("separates web-ahead updates from merge review", () => {
    const base = deriveAppCloudSyncStatus(
      APP,
      items({ publishLive: true, publishedAt: "2026-08-26T02:00:00.000Z" }),
      "synced",
    );
    const ahead = mergeRemoteCodeCheckIntoStatus(base, {
      upToDate: false,
      remoteCommitSha: "abc",
    });
    expect(webSyncVisualState(ahead, {})).toBe("updates_available");
    expect(
      resolvePublishBarChipLabel({
        state: "updates_available",
        live: true,
        syncEnabled: true,
        lastCheckedAt: Date.now(),
      }).label,
    ).toBe("Updates on web");
    expect(
      resolvePublishBarPrimaryAction({
        state: "updates_available",
        live: true,
        syncEnabled: true,
        pushing: false,
        pulling: false,
      }),
    ).toEqual({ label: "Get updates", kind: "updates" });

    const review = {
      ...base,
      gitRemoteRequiresReview: true,
      gitUpdatesAvailable: true,
    };
    expect(webSyncVisualState(review, {})).toBe("action_required");
    expect(
      resolvePublishBarPrimaryAction({
        state: "action_required",
        live: true,
        syncEnabled: true,
        pushing: false,
        pulling: false,
      }),
    ).toEqual({ label: "Review changes", kind: "review" });
  });

  it("offers publisher update on fork web preview when upstream revision is ahead", () => {
    const forkChip = resolvePublishBarChipForForkUpstream({
      forkWebPreview: true,
      publisherUpdatesAvailable: true,
    });
    expect(forkChip?.label).toBe("Publisher has updates");
    expect(
      resolvePublishBarPrimaryAction({
        state: "synced",
        live: true,
        syncEnabled: true,
        pushing: false,
        pulling: false,
        forkWebPreview: true,
        publisherUpdatesAvailable: true,
      }),
    ).toEqual({ label: "Update", kind: "upstream" });
  });
});
