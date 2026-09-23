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

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  deriveAppCloudSyncStatus,
  formatWebSyncStatusTooltip,
  mergeRemoteCodeCheckIntoStatus,
  resolvePublishBarChipAction,
  resolvePublishBarChipForForkUpstream,
  resolvePublishBarChipLabel,
  resolvePublishBarPrimaryAction,
  webSyncShouldPullBeforePublish,
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
    expect(chip.tone).toBe("ok");
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
    expect(chip.tone).toBe("ok");
    expect(chip.label).not.toContain("Checking");
  });
});

describe("publish bar v2 chip labels", () => {
  it("shows Checking while publish state is loading", () => {
    const chip = resolvePublishBarChipLabel({
      state: "loading",
      live: false,
      syncEnabled: true,
      lastCheckedAt: null,
    });
    expect(chip.label).toBe("Checking…");
    expect(chip.label).not.toBe("Draft");
  });

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

  it("shows cloud-ahead updates even when local phase looks changed", () => {
    const base = deriveAppCloudSyncStatus(
      APP,
      items({ publishLive: true, publishedAt: "2026-08-26T02:00:00.000Z" }),
      "synced",
    );
    const withLocalEdits = { ...base, hasLocalChanges: true, codeStatus: "changed" as const };
    const ahead = mergeRemoteCodeCheckIntoStatus(withLocalEdits, {
      upToDate: false,
      remoteCommitSha: "abc",
    });
    expect(ahead.codeStatus).toBe("updates_available");
    expect(ahead.summaryLine).toContain("get updates");
  });

  it("shows Getting updates while pulling even when cloud is ahead", () => {
    const base = deriveAppCloudSyncStatus(
      APP,
      items({ publishLive: true, publishedAt: "2026-08-26T02:00:00.000Z" }),
      "synced",
    );
    const ahead = mergeRemoteCodeCheckIntoStatus(base, {
      upToDate: false,
      remoteCommitSha: "abc",
    });
    expect(webSyncVisualState(ahead, { pulling: true })).toBe("syncing");
    expect(
      resolvePublishBarChipLabel({
        state: "syncing",
        live: true,
        syncEnabled: true,
        lastCheckedAt: Date.now(),
        pulling: true,
      }).label,
    ).toBe("Getting updates…");
    // The primary slot never pulls, but it does report an in-flight pull —
    // disabled, so the only enabled control during a pull is the one that
    // started it.
    expect(
      resolvePublishBarPrimaryAction({
        state: "syncing",
        live: true,
        syncEnabled: true,
        pushing: false,
        pulling: true,
      }),
    ).toMatchObject({
      label: "Getting updates…",
      kind: "publish",
      disabled: true,
    });
  });

  it("requires pull before publish when web writer is ahead", () => {
    const base = deriveAppCloudSyncStatus(
      APP,
      items({ publishLive: true, publishedAt: "2026-08-26T02:00:00.000Z" }),
      "synced",
    );
    const ahead = mergeRemoteCodeCheckIntoStatus(base, {
      upToDate: false,
      remoteCommitSha: "abc",
    });
    expect(webSyncShouldPullBeforePublish(ahead)).toBe(true);
    expect(
      webSyncShouldPullBeforePublish({
        ...ahead,
        gitRemoteRequiresReview: true,
      }),
    ).toBe(false);
    expect(
      webSyncShouldPullBeforePublish({
        ...ahead,
        writerConflict: true,
      }),
    ).toBe(false);
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
    // Pull lives on the chip now. The primary stays put and greys out, because
    // nothing of yours is waiting to go up when the web copy is ahead.
    expect(
      resolvePublishBarChipAction({
        state: "updates_available",
        live: true,
        syncEnabled: true,
        pushing: false,
        pulling: false,
      }),
    ).toMatchObject({ kind: "updates", verb: "Get updates", glyph: "down" });
    expect(
      resolvePublishBarPrimaryAction({
        state: "updates_available",
        live: true,
        syncEnabled: true,
        pushing: false,
        pulling: false,
      }),
    ).toMatchObject({ label: "Publish changes", disabled: true });

    const review = {
      ...base,
      gitRemoteRequiresReview: true,
      gitUpdatesAvailable: true,
    };
    expect(webSyncVisualState(review, {})).toBe("action_required");
    expect(
      resolvePublishBarChipAction({
        state: "action_required",
        live: true,
        syncEnabled: true,
        pushing: false,
        pulling: false,
      }),
    ).toMatchObject({ kind: "review", verb: "Review changes", glyph: "open" });
    expect(
      resolvePublishBarPrimaryAction({
        state: "action_required",
        live: true,
        syncEnabled: true,
        pushing: false,
        pulling: false,
      }),
    ).toMatchObject({ kind: "publish", disabled: true });
  });

  it("keeps the primary slot present and push-only in every live state", () => {
    // The reported bug was a button that appeared in some states and vanished
    // in others. Every live state must yield a publish-direction button.
    const states = [
      "synced",
      "warn",
      "updates_available",
      "action_required",
      "error",
      "loading",
    ] as const;
    for (const state of states) {
      const action = resolvePublishBarPrimaryAction({
        state,
        live: true,
        syncEnabled: true,
        pushing: false,
        pulling: false,
      });
      expect(action, `state ${state} dropped the primary button`).not.toBeNull();
      expect(action?.kind === "publish" || action?.kind === "retry").toBe(true);
      expect(action?.title.length, `state ${state} had no reason text`).toBeGreaterThan(0);
    }
  });

  it("offers publisher update on fork web preview when upstream revision is ahead", () => {
    const forkChip = resolvePublishBarChipForForkUpstream({
      forkWebPreview: true,
      publisherUpdatesAvailable: true,
    });
    expect(forkChip?.label).toBe("Publisher has updates");
    expect(
      resolvePublishBarChipAction({
        state: "synced",
        live: true,
        syncEnabled: true,
        pushing: false,
        pulling: false,
        forkWebPreview: true,
        publisherUpdatesAvailable: true,
      }),
    ).toMatchObject({ kind: "upstream", verb: "Update from publisher" });
    // A fork with nothing local to send still shows Publish changes, greyed —
    // the slot does not change meaning just because you are on someone's fork.
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
    ).toMatchObject({ kind: "publish", disabled: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows green Live when web sync was checked recently", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T18:00:00.000Z"));
    const now = Date.now();
    const chip = resolvePublishBarChipLabel({
      state: "synced",
      live: true,
      syncEnabled: true,
      lastCheckedAt: now - 5 * 60_000,
      lastPublishedAt: "2026-09-22T10:00:00.000Z",
    });
    expect(chip.tone).toBe("ok");
    expect(chip.label).toBe("Live · last checked 5m ago");
  });

  it("stays green with last checked when the check is old", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T18:00:00.000Z"));
    const now = Date.now();
    const chip = resolvePublishBarChipLabel({
      state: "synced",
      live: true,
      syncEnabled: true,
      lastCheckedAt: now - 45 * 60_000,
      lastPublishedAt: "2026-09-22T10:00:00.000Z",
    });
    expect(chip.tone).toBe("ok");
    expect(chip.label).toBe("Live · last checked 45m ago");
  });
});
