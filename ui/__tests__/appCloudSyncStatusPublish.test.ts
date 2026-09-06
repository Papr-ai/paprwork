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
