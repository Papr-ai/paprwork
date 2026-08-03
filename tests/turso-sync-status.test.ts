import { describe, expect, it } from "vitest";
import { resolveTursoSourceStatus } from "../src/gateway/services/tursoSyncStatus.js";
import { deriveAppCloudSyncStatus } from "../ui/utils/appCloudSyncStatus";
import type { SyncItemsResponse } from "../ui/components/Settings/CloudSyncDetails";

describe("resolveTursoSourceStatus", () => {
  it("reports quarantined when local DB is corrupt", () => {
    expect(resolveTursoSourceStatus(10, 10, true, false, true)).toBe("quarantined");
  });

  it("reports pending when remote has tables but local is dirty", () => {
    expect(resolveTursoSourceStatus(30, 30, true, true)).toBe("pending");
  });

  it("reports pending when local has more tables than remote (schema drift)", () => {
    expect(resolveTursoSourceStatus(6, 5, true, false)).toBe("pending");
  });

  it("reports synced when remote has tables and local is clean", () => {
    expect(resolveTursoSourceStatus(30, 30, true, false)).toBe("synced");
  });

  it("reports pending when local has tables but remote is empty", () => {
    expect(resolveTursoSourceStatus(5, 0, true, false)).toBe("pending");
  });
});

describe("deriveAppCloudSyncStatus database detail", () => {
  it("shows unpushed changes hint when db is pending with remote tables", () => {
    const items: SyncItemsResponse = {
      enabled: true,
      github: {
        workspace: [],
        apps: [
          {
            id: "app-1",
            kind: "app",
            label: "Test",
            relativePath: "apps/app-1",
            status: "synced",
            lastSyncAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        jobs: [],
        queuedPaths: [],
        summary: { synced: 1, pending: 0, outdated: 0, failed: 0, total: 1 },
      },
      turso: {
        enabled: true,
        error: null,
        sources: [
          {
            appId: "app-1",
            jobId: "job-1",
            alias: "audit",
            role: "primary",
            dbPath: "/tmp/data.db",
            status: "pending",
            localTableCount: 30,
            remoteTableCount: 30,
          },
        ],
        summary: { synced: 0, pending: 1, empty: 0, unavailable: 0, quarantined: 0, total: 1 },
      },
    };
    const status = deriveAppCloudSyncStatus("app-1", items, "idle");
    expect(status.overall).toBe("needs_sync");
    expect(status.databases[0]?.detail).toBe(
      "Local DB changes not on Turso yet",
    );
  });
});
