import { describe, expect, it } from "vitest";
import { deriveAppCloudSyncStatus } from "../ui/utils/appCloudSyncStatus";
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
      summary: { synced: 1, pending: 0, outdated: 0, total: 1 },
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
  it("reports synced when code and databases are synced", () => {
    const status = deriveAppCloudSyncStatus(
      "app-1",
      baseItems({
        appId: "app-1",
        databases: [{ alias: "main", jobId: "job-1", status: "synced" }],
      }),
      "idle",
    );
    expect(status.overall).toBe("synced");
    expect(status.chipLabel).toBe("Synced");
  });

  it("reports needs_sync when app code was never uploaded", () => {
    const status = deriveAppCloudSyncStatus(
      "app-1",
      baseItems({ appId: "app-1", codeStatus: "pending" }),
      "idle",
    );
    expect(status.overall).toBe("needs_sync");
    expect(status.codePhase).toBe("not_uploaded");
    expect(status.chipLabel).toBe("Needs sync");
  });

  it("reports needs_sync when a linked database is pending", () => {
    const status = deriveAppCloudSyncStatus(
      "app-1",
      baseItems({
        appId: "app-1",
        databases: [{ alias: "metrics", jobId: "job-2", status: "pending" }],
      }),
      "idle",
    );
    expect(status.overall).toBe("needs_sync");
  });

  it("reports needs_sync (not uploading) when app is queued but not actively pushing", () => {
    const items = baseItems({ appId: "app-1", codeStatus: "pending" });
    items.github!.queuedPaths = ["apps/app-1"];

    const status = deriveAppCloudSyncStatus("app-1", items, "queuing");
    expect(status.overall).toBe("needs_sync");
    expect(status.chipLabel).toBe("Needs sync");
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
    items.appContext = { appId: "app-1", dependentJobIds: ["job-2"] };

    const status = deriveAppCloudSyncStatus("app-1", items, "queuing");
    expect(status.overall).toBe("synced");
    expect(status.syncedJobCount).toBe(1);
    expect(status.chipLabel).toBe("Synced");
  });

  it("stays synced when workspace git is queuing but this app is ready", () => {
    const status = deriveAppCloudSyncStatus(
      "app-1",
      baseItems({
        appId: "app-1",
        databases: [{ alias: "main", jobId: "job-1", status: "empty" }],
      }),
      "queuing",
    );
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
    expect(status.chipLabel).toBe("Needs sync");
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
    expect(status.chipLabel).toBe("Needs sync (0/1)");
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
    expect(status.chipLabel).toBe("Needs sync (0/1)");
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
    expect(status.chipLabel).toBe("Uploading 0/1…");
  });
});
