/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach } from "vitest";
import type { SyncItemsResponse } from "../ui/components/Settings/CloudSyncDetails";
import {
  readCachedAppCloudSyncStatus,
  writeCloudSyncTabSnapshot,
} from "../ui/utils/cloudSyncTabCache";

const STORAGE_KEY = "paprwork.cloudSyncSnapshot.v2";

function sampleItems(appId: string): SyncItemsResponse {
  return {
    enabled: true,
    github: {
      workspace: [],
      apps: [
        {
          id: appId,
          kind: "app",
          label: "Cached App",
          relativePath: `apps/${appId}`,
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
      sources: [],
      summary: {
        synced: 0,
        pending: 0,
        empty: 0,
        unavailable: 0,
        total: 0,
      },
    },
  };
}

describe("cloudSyncTabCache", () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  it("derives per-app status from persisted snapshot", () => {
    writeCloudSyncTabSnapshot({
      gitStatus: { enabled: true, status: "idle" },
      vaultStatus: null,
      syncItems: sampleItems("app-abc"),
    });

    const status = readCachedAppCloudSyncStatus("app-abc");
    expect(status?.overall).toBe("synced");
    expect(status?.chipLabel).toBe("Synced");
  });

  it("returns null when no snapshot exists", () => {
    expect(readCachedAppCloudSyncStatus("missing")).toBeNull();
  });
});
