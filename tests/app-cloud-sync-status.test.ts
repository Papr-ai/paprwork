import { describe, expect, it } from "vitest";
import {
  deriveAppCloudSyncStatus,
  formatWebSyncStatusTooltip,
  resolvePublishBarStatus,
  webSyncVisualState,
  type AppCloudSyncStatus,
} from "../ui/utils/appCloudSyncStatus";
import type { SyncItemsResponse } from "../ui/components/Settings/CloudSyncDetails";

function baseItems(
  overrides: Partial<SyncItemsResponse> & {
    appId: string;
    codeStatus?: "synced" | "pending" | "outdated";
    databases?: Array<{
      alias: string;
      jobId: string;
      status: "synced" | "pending" | "empty" | "unavailable";
      localTableCount?: number;
      remoteTableCount?: number;
    }>;
  },
): SyncItemsResponse {
  const { appId, codeStatus = "synced", databases = [] } = overrides;
  return {
    enabled: true,
    github: {
      workspace: [],
      apps: [
        {
          id: appId,
          kind: "app",
          label: "Test App",
          relativePath: `apps/${appId}`,
          status: codeStatus,
          lastSyncAt: codeStatus === "synced" ? "2026-01-01T00:00:00.000Z" : null,
        },
      ],
      jobs: [],
      queuedPaths: [],
      summary: { synced: 1, pending: 0, outdated: 0, failed: 0, updatesAvailable: 0, total: 1 },
    },
    turso: {
      enabled: true,
      error: null,
      sources: databases.map((db) => ({
        appId,
        jobId: db.jobId,
        alias: db.alias,
        role: "linked",
        dbPath: `/tmp/${db.jobId}/data.db`,
        status: db.status,
        localTableCount: db.localTableCount ?? 1,
        remoteTableCount: db.remoteTableCount ?? 1,
      })),
      summary: {
        synced: databases.filter((d) => d.status === "synced").length,
        pending: databases.filter((d) => d.status === "pending").length,
        empty: databases.filter((d) => d.status === "empty").length,
        unavailable: databases.filter((d) => d.status === "unavailable").length,
        total: databases.length,
      },
    },
  };
}

describe("deriveAppCloudSyncStatus", () => {
  it("reports synced when code, databases, and publish are ready", () => {
    const items = baseItems({
      appId: "app-1",
      databases: [{ alias: "main", jobId: "job-1", status: "synced" }],
    });
    items.appContext = {
      appId: "app-1",
      dependentJobIds: [],
      publishLive: true,
      publishedAt: "2026-01-01T00:00:00.000Z",
    };
    items.publish = { status: "synced", detail: "Live on the web" };

    const status = deriveAppCloudSyncStatus("app-1", items, "idle");
    expect(status.overall).toBe("synced");
    expect(status.chipLabel).toBe("Synced");
    expect(status.summaryLine).toContain("Last published");
    expect(status.lastUploadedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("shows synced when code is synced but app was never published live", () => {
    const status = deriveAppCloudSyncStatus(
      "app-1",
      baseItems({
        appId: "app-1",
        databases: [{ alias: "main", jobId: "job-1", status: "synced" }],
      }),
      "idle",
    );
    expect(status.overall).toBe("synced");
    expect(status.publishLive).toBeFalsy();
  });

  it("reports synced when app is live on web but git sync-state lags", () => {
    const items = baseItems({ appId: "app-1", codeStatus: "pending" });
    items.appContext = {
      appId: "app-1",
      dependentJobIds: [],
      publishLive: true,
      publishedAt: "2026-02-01T12:00:00.000Z",
    };
    items.publish = {
      status: "synced",
      detail: "Live on the web — local git sync is catching up",
    };

    const status = deriveAppCloudSyncStatus("app-1", items, "idle");
    expect(status.overall).toBe("synced");
    expect(status.codePhase).toBe("synced");
    expect(status.codeLabel).toBe("App code on the web");
    expect(status.registryLabel).not.toContain("not on web");
    expect(status.chipLabel).toBe("Synced");
    expect(status.lastUploadedAt).toBe("2026-02-01T12:00:00.000Z");
    expect(webSyncVisualState(status)).toBe("synced");
  });

  it("shows green dot when live app has background coordinator upload", () => {
    const items = baseItems({ appId: "app-1", codeStatus: "pending" });
    items.appContext = {
      appId: "app-1",
      dependentJobIds: [],
      publishLive: true,
    };
    items.publish = {
      status: "synced",
      detail: "Live on the web — local git sync is catching up",
    };
    items.upload = {
      status: "uploading",
      label: "Upload in progress…",
      detail: "Usually under a minute.",
      appId: "app-1",
    };

    const status = deriveAppCloudSyncStatus("app-1", items, "idle");
    expect(status.overall).toBe("synced");
    expect(status.summaryLine).toBe("Everything for this app matches the web");
    expect(status.uploadStatus).toBeUndefined();
    expect(webSyncVisualState(status)).toBe("synced");
  });

  it("does not claim everything matches when local code changed on a live app", () => {
    const items = baseItems({ appId: "app-1", codeStatus: "synced" });
    items.appContext = {
      appId: "app-1",
      dependentJobIds: [],
      publishLive: true,
      publishedAt: "2026-01-01T00:00:00.000Z",
    };
    items.publish = { status: "synced", detail: "Live on the web" };
    items.appSync = {
      protocol: "v3",
      appId: "app-1",
      relativePath: "apps/app-1",
      status: "pending",
      phase: "changed",
      label: "Local changes not on web",
      detail: "2 writer change(s) waiting to publish",
      lastUploadedAt: "2026-01-01T00:00:00.000Z",
      pendingWriterOps: 2,
      inflightWriterOps: 0,
      deadLetterWriterOps: 0,
      hasLocalChanges: true,
      queuedForUpload: false,
    };

    const status = deriveAppCloudSyncStatus("app-1", items, "idle");
    expect(status.overall).toBe("needs_sync");
    expect(status.summaryLine).not.toContain("Everything for this app matches");
    expect(status.summaryLine).toContain("local app changes not on web yet");
    expect(webSyncVisualState(status)).toBe("warn");
  });

  it("reports needs_sync when app code was never uploaded", () => {
    const status = deriveAppCloudSyncStatus(
      "app-1",
      baseItems({ appId: "app-1", codeStatus: "pending" }),
      "idle",
    );
    expect(status.overall).toBe("needs_sync");
    expect(status.codePhase).toBe("not_uploaded");
    expect(status.chipLabel).toBe("Not published");
  });

  it("reports needs_sync when a linked database is pending with no remote copy", () => {
    const status = deriveAppCloudSyncStatus(
      "app-1",
      baseItems({
        appId: "app-1",
        databases: [
          {
            alias: "metrics",
            jobId: "job-2",
            status: "pending",
            remoteTableCount: 0,
            localTableCount: 2,
          },
        ],
      }),
      "idle",
    );
    expect(status.overall).toBe("needs_sync");
  });

  it("stays synced when a linked database has background row sync only", () => {
    const status = deriveAppCloudSyncStatus(
      "app-1",
      baseItems({
        appId: "app-1",
        databases: [{ alias: "metrics", jobId: "job-2", status: "pending" }],
      }),
      "idle",
    );
    expect(status.overall).toBe("synced");
  });

  it("stays synced when coordinator upload is waiting on an already-live app", () => {
    const items = baseItems({
      appId: "app-1",
      databases: [{ alias: "main", jobId: "job-1", status: "synced" }],
    });
    items.appContext = {
      appId: "app-1",
      dependentJobIds: [],
      publishLive: true,
      publishedAt: "2026-01-01T00:00:00.000Z",
    };
    items.publish = { status: "synced", detail: "Live on the web" };
    items.upload = {
      status: "waiting",
      label: "Changes waiting to publish",
      detail: "Database changes are waiting to sync to the web.",
    };

    const status = deriveAppCloudSyncStatus("app-1", items, "idle");
    expect(status.overall).toBe("synced");
    expect(status.uploadStatus).toBeUndefined();
  });

  it("shows queue position in summary when upload is queued before first publish", () => {
    const items = baseItems({ appId: "app-1", codeStatus: "pending" });
    items.upload = {
      status: "waiting",
      waitingReason: "queued",
      queuePosition: 3,
      queueDepth: 8,
      label: "2 apps ahead · 8 in queue",
      detail:
        "2 other apps uploading first (8 apps in queue). Use Publish changes or Move to front to skip the line.",
    };
    items.appSync = {
      protocol: "v3",
      appId: "app-1",
      relativePath: "apps/app-1",
      status: "pending",
      phase: "changed",
      label: "2 apps ahead · 8 in queue",
      detail:
        "2 other apps uploading first (8 apps in queue). Use Publish changes or Move to front to skip the line.",
      lastUploadedAt: null,
      pendingWriterOps: 0,
      inflightWriterOps: 0,
      deadLetterWriterOps: 0,
      hasLocalChanges: true,
      queuedForUpload: true,
    };

    const status = deriveAppCloudSyncStatus("app-1", items, "idle");
    expect(status.overall).toBe("needs_sync");
    expect(status.summaryLine).toContain("2 apps ahead");
    expect(status.codePhase).not.toBe("uploading");
  });

  it("stays synced when queued globally but app is already on the web", () => {
    const items = baseItems({ appId: "app-1", codeStatus: "synced" });
    items.upload = {
      status: "waiting",
      waitingReason: "queued",
      queuePosition: 3,
      queueDepth: 14,
      label: "1 app ahead · 14 in queue",
      detail:
        "1 other app uploading first (14 apps in queue). Use Publish changes or Move to front to skip the line.",
    };
    items.appSync = {
      protocol: "v3",
      appId: "app-1",
      relativePath: "apps/app-1",
      status: "synced",
      phase: "synced",
      label: "App code on the web",
      detail: "Last published Jan 1, 2026",
      lastUploadedAt: "2026-01-01T00:00:00.000Z",
      pendingWriterOps: 0,
      inflightWriterOps: 0,
      deadLetterWriterOps: 0,
      hasLocalChanges: false,
      queuedForUpload: true,
    };
    items.appContext = {
      appId: "app-1",
      dependentJobIds: [],
      publishLive: true,
    };
    items.publish = { status: "synced", detail: "Live on the web" };

    const status = deriveAppCloudSyncStatus("app-1", items, "idle");
    expect(status.overall).toBe("synced");
    expect(status.uploadQueued).toBeUndefined();
    expect(status.summaryLine).not.toContain("app ahead");
    expect(status.chipLabel).toBe("Synced");
  });

  it("reports needs_sync (not uploading) when app is queued but not actively pushing", () => {
    const items = baseItems({ appId: "app-1", codeStatus: "pending" });
    items.github!.queuedPaths = ["apps/app-1"];

    const status = deriveAppCloudSyncStatus("app-1", items, "queuing");
    expect(status.overall).toBe("needs_sync");
    expect(status.chipLabel).toBe("Not published");
  });

  it("reports synced jobs even when stale queue entries remain", () => {
    const items = baseItems({ appId: "app-1", codeStatus: "synced" });
    items.github!.jobs = [
      {
        id: "job-2",
        kind: "job",
        label: "Metrics Job",
        relativePath: "Jobs/job-2",
        status: "synced",
        lastSyncAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    items.github!.queuedPaths = ["Jobs/job-2"];
    items.appContext = {
      appId: "app-1",
      dependentJobIds: ["job-2"],
      publishLive: true,
    };
    items.publish = { status: "synced", detail: "Live on the web" };

    const status = deriveAppCloudSyncStatus("app-1", items, "queuing");
    expect(status.overall).toBe("synced");
    expect(status.syncedJobCount).toBe(1);
    expect(status.chipLabel).toBe("Synced");
  });

  it("stays synced when workspace git is queuing but this app is ready", () => {
    const items = baseItems({
      appId: "app-1",
      databases: [{ alias: "main", jobId: "job-1", status: "empty" }],
    });
    items.appContext = {
      appId: "app-1",
      dependentJobIds: [],
      publishLive: true,
    };
    items.publish = { status: "synced", detail: "Live on the web" };

    const status = deriveAppCloudSyncStatus("app-1", items, "queuing");
    expect(status.overall).toBe("synced");
    expect(status.globallySyncing).toBe(true);
    expect(status.chipLabel).toBe("Synced");
  });

  it("reports needs_sync when code changed locally", () => {
    const items = baseItems({ appId: "app-1", codeStatus: "outdated" });
    items.github!.apps[0]!.lastSyncAt = "2026-01-01T00:00:00.000Z";

    const status = deriveAppCloudSyncStatus("app-1", items, "idle");
    expect(status.overall).toBe("needs_sync");
    expect(status.codePhase).toBe("changed");
    expect(status.chipLabel).toBe("Not published");
  });

  it("reports needs_sync when a dependent job changed locally", () => {
    const items = baseItems({ appId: "app-1", codeStatus: "synced" });
    items.github!.jobs = [
      {
        id: "job-2",
        kind: "job",
        label: "Metrics Job",
        relativePath: "Jobs/job-2",
        status: "outdated",
        lastSyncAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    items.appContext = { appId: "app-1", dependentJobIds: ["job-2"] };

    const status = deriveAppCloudSyncStatus("app-1", items, "idle");
    expect(status.overall).toBe("needs_sync");
    expect(status.dependentJobs).toHaveLength(1);
    expect(status.chipLabel).toBe("Not published (0/1 jobs)");
  });

  it("reports needs_sync (not uploading) when dependent jobs were never uploaded", () => {
    const items = baseItems({ appId: "app-1", codeStatus: "synced" });
    items.github!.jobs = [
      {
        id: "job-2",
        kind: "job",
        label: "Metrics Job",
        relativePath: "Jobs/job-2",
        status: "pending",
        lastSyncAt: null,
      },
    ];
    items.appContext = { appId: "app-1", dependentJobIds: ["job-2"] };

    const status = deriveAppCloudSyncStatus("app-1", items, "idle");
    expect(status.overall).toBe("needs_sync");
    expect(status.dependentJobs[0]?.phase).toBe("not_uploaded");
    expect(status.chipLabel).toBe("Not published (0/1 jobs)");
  });

  it("reports uploading while client push is in flight", () => {
    const items = baseItems({ appId: "app-1", codeStatus: "outdated" });
    items.github!.apps[0]!.lastSyncAt = "2026-01-01T00:00:00.000Z";
    items.github!.jobs = [
      {
        id: "job-2",
        kind: "job",
        label: "Metrics Job",
        relativePath: "Jobs/job-2",
        status: "pending",
        lastSyncAt: null,
      },
    ];
    items.appContext = { appId: "app-1", dependentJobIds: ["job-2"] };

    const status = deriveAppCloudSyncStatus("app-1", items, "idle", {
      isUploading: true,
    });
    expect(status.overall).toBe("uploading");
    expect(status.chipLabel).toBe("Publishing 0/1…");
  });

  it("flags registry when app code (linked-databases.json) is not synced", () => {
    const items = baseItems({ appId: "app-1", codeStatus: "pending" });
    items.appContext = { appId: "app-1", dependentJobIds: [], registryDbIds: ["db-2e4a46d7"] };

    const status = deriveAppCloudSyncStatus("app-1", items, "idle");
    expect(status.overall).toBe("needs_sync");
    expect(status.hasRegistryDatabases).toBe(true);
    expect(status.registryPhase).toBe("not_uploaded");
    expect(status.summaryLine).toContain("database registry not on web yet");
  });

  it("reports changed locally when app is on git but sync state is missing", () => {
    const items = baseItems({ appId: "app-1", codeStatus: "outdated" });
    items.github!.apps[0]!.lastSyncAt = null;

    const status = deriveAppCloudSyncStatus("app-1", items, "idle");
    expect(status.codePhase).toBe("changed");
    expect(status.codeLabel).toBe("App code changed locally");
    expect(status.summaryLine).toContain("local app changes not on web yet");
    expect(status.summaryLine).not.toContain("not published yet");
  });

  it("does not treat row-only turso pending as blocking sync chip", () => {
    const items = baseItems({
      appId: "app-1",
      databases: [
        {
          alias: "main",
          jobId: "job-1",
          status: "pending",
          localTableCount: 3,
          remoteTableCount: 3,
        },
      ],
    });
    items.appContext = {
      appId: "app-1",
      dependentJobIds: [],
      publishLive: true,
    };
    items.publish = { status: "synced", detail: "Live on the web" };

    const status = deriveAppCloudSyncStatus("app-1", items, "idle");
    expect(status.overall).toBe("synced");
    expect(status.databases[0]?.detail).toContain("background");
  });

  it("stays synced on web when live app has row-level turso lag", () => {
    const items = baseItems({
      appId: "app-1",
      databases: [
        {
          alias: "main",
          jobId: "job-1",
          status: "pending",
          localTableCount: 5,
          remoteTableCount: 5,
        },
      ],
    });
    items.appContext = {
      appId: "app-1",
      dependentJobIds: [],
      publishLive: true,
    };
    items.publish = {
      status: "synced",
      detail: "Live on the web",
    };

    const status = deriveAppCloudSyncStatus("app-1", items, "idle");
    expect(status.overall).toBe("synced");
    expect(status.databases[0]?.rowsSyncing).toBe(true);
    expect(status.summaryLine).toContain("publishing data in the background");
  });

  it("shows yellow when publish layer blocks web readiness", () => {
    const items = baseItems({
      appId: "app-1",
      databases: [{ alias: "main", jobId: "job-1", status: "synced" }],
    });
    items.appContext = {
      appId: "app-1",
      dependentJobIds: [],
      publishLive: true,
    };
    items.publish = {
      status: "not_web_ready",
      reason: "turso_pending",
      detail: "main: pending",
    };

    const status = deriveAppCloudSyncStatus("app-1", items, "idle");
    expect(status.overall).toBe("needs_sync");
    expect(status.chipLabel).toBe("Still publishing");
    expect(status.publishStatus).toBe("not_web_ready");
    expect(status.publishLabel).toContain("main: pending");
  });

  it("formats web sync status tooltip for the status dot", () => {
    const synced = deriveAppCloudSyncStatus(
      "app-1",
      baseItems({ appId: "app-1" }),
      "idle",
    );
    expect(formatWebSyncStatusTooltip(synced)).toBe(synced.summaryLine);

    const pending = deriveAppCloudSyncStatus(
      "app-1",
      baseItems({ appId: "app-1", codeStatus: "pending" }),
      "idle",
    );
    expect(formatWebSyncStatusTooltip(pending)).toContain("not published yet");

    expect(formatWebSyncStatusTooltip(null, { loading: true })).toBe(
      "Checking what's on the web…",
    );
    expect(formatWebSyncStatusTooltip(null, { error: "offline" })).toBe(
      "Web sync unavailable — offline",
    );
  });

  it("treats backend metadata-sync flag as auto-integrating job status", () => {
    const items = baseItems({ appId: "app-1", codeStatus: "synced" });
    items.appContext = {
      appId: "app-1",
      dependentJobIds: [],
      publishLive: true,
    };
    items.publish = { status: "synced", detail: "Live on the web" };
    items.github!.gitUpdatesAvailable = true;
    items.github!.gitRemoteRequiresReview = false;
    items.github!.gitRemoteMetadataSync = true;
    items.github!.gitUpdatesSummary = [
      "9808dd10 cloud: update job abc status",
      "e0e4c717 cloud: update job def status",
    ].join("\n");

    const status = deriveAppCloudSyncStatus("app-1", items, "idle");
    expect(status.gitRemoteRequiresReview).toBe(false);
    expect(status.gitRemoteMetadataSync).toBe(true);
    expect(status.chipLabel).toBe("Syncing job status…");
    expect(status.overall).toBe("synced");
    expect(status.summaryLine).toContain("Syncing cloud job status");
  });

  it("passes through gitRemoteReviewHeadline from backend", () => {
    const items = baseItems({ appId: "app-1", codeStatus: "outdated" });
    items.github!.gitUpdatesAvailable = true;
    items.github!.gitRemoteRequiresReview = true;
    items.github!.gitRemoteReviewHeadline =
      "1 contributed code merge + 8 cloud job status updates";

    const status = deriveAppCloudSyncStatus("app-1", items, "idle");
    expect(status.gitRemoteReviewHeadline).toBe(
      "1 contributed code merge + 8 cloud job status updates",
    );
    expect(status.gitRemoteRequiresReview).toBe(true);
  });

  it("uses action_required visual state when remote code needs review", () => {
    const items = baseItems({ appId: "app-1", codeStatus: "outdated" });
    items.github!.gitUpdatesAvailable = true;
    items.github!.gitRemoteRequiresReview = true;
    items.github!.gitUpdatesSummary = "abc1234 cloud: update app dashboard";

    const status = deriveAppCloudSyncStatus("app-1", items, "idle");
    expect(status.gitRemoteRequiresReview).toBe(true);
    expect(formatWebSyncStatusTooltip(status)).toContain("Action needed");
  });

  it("keeps last status visible while refreshing in the background", () => {
    const items = baseItems({ appId: "app-1" });
    items.appContext = {
      appId: "app-1",
      dependentJobIds: [],
      publishLive: true,
    };
    items.publish = { status: "synced", detail: "Live on the web" };

    const status = deriveAppCloudSyncStatus("app-1", items, "idle", {
      refreshing: true,
    });
    expect(status.overall).toBe("synced");
    expect(status.summaryLine).not.toBe("Checking for updates…");
    expect(status.summaryLine.length).toBeGreaterThan(0);
    expect(formatWebSyncStatusTooltip(status, { refreshing: true })).not.toBe(
      "Checking for updates…",
    );
  });

  it("does not report uploading when coordinator is only waiting", () => {
    const items = baseItems({ appId: "app-1", codeStatus: "outdated" });
    items.github!.apps[0]!.lastSyncAt = "2026-01-01T00:00:00.000Z";
    items.upload = {
      status: "waiting",
      label: "Changes waiting to publish",
      detail: "App file changes are waiting to publish.",
    };

    const status = deriveAppCloudSyncStatus("app-1", items, "idle");
    expect(status.overall).toBe("needs_sync");
    expect(status.summaryLine).toContain("local app changes not on web yet");
    expect(status.summaryLine).not.toContain("Uploading");
  });

  it("prefers Sync V3 appSync report over legacy github app row", () => {
    const items = baseItems({ appId: "app-1", codeStatus: "synced" });
    items.appSync = {
      protocol: "v3",
      appId: "app-1",
      relativePath: "apps/app-1",
      status: "pending",
      phase: "changed",
      label: "Local changes not on web",
      detail: "2 writer change(s) waiting to publish",
      lastUploadedAt: "2026-01-01T00:00:00.000Z",
      pendingWriterOps: 2,
      inflightWriterOps: 0,
      deadLetterWriterOps: 0,
      hasLocalChanges: true,
      queuedForUpload: false,
    };

    const status = deriveAppCloudSyncStatus("app-1", items, "idle");
    expect(status.overall).toBe("needs_sync");
    expect(status.codeLabel).toBe("2 writer change(s) waiting to publish");
    expect(status.summaryLine).toContain("local app changes not on web yet");
  });

  it("reports needs_sync when coordinator is uploading before first publish", () => {
    const items = baseItems({ appId: "app-1", codeStatus: "outdated" });
    items.github!.apps[0]!.lastSyncAt = "2026-01-01T00:00:00.000Z";
    items.upload = {
      status: "uploading",
      label: "Upload in progress…",
      detail: "Usually under a minute.",
    };

    const status = deriveAppCloudSyncStatus("app-1", items, "idle");
    expect(status.overall).toBe("needs_sync");
    expect(status.summaryLine).toContain("local app changes not on web yet");
  });
});

describe("resolvePublishBarStatus", () => {
  it("resolves unified publish bar status from live + sync state", () => {
    expect(
      resolvePublishBarStatus({
        live: false,
        loading: false,
        refreshing: false,
        syncEnabled: false,
        webSyncState: "disabled",
        webSyncSpinning: false,
        webSyncTooltip: "",
      }).state,
    ).toBe("disabled");

    expect(
      resolvePublishBarStatus({
        live: true,
        loading: false,
        refreshing: false,
        syncEnabled: true,
        webSyncState: "warn",
        webSyncSpinning: false,
        webSyncTooltip: "App code changed locally",
      }),
    ).toMatchObject({ state: "warn", interactive: true });

    expect(
      resolvePublishBarStatus({
        live: true,
        loading: false,
        refreshing: false,
        syncEnabled: true,
        webSyncState: "synced",
        webSyncSpinning: false,
        webSyncTooltip: "Synced",
      }).state,
    ).toBe("synced");
  });
});
