import { describe, expect, it, vi } from "vitest";
import type { CloudSyncService } from "../src/gateway/services/CloudSyncService.js";
import {
  appNeedsOrderedFlush,
  appNeedsOrderedFlushAsync,
} from "../src/gateway/services/cloudSync/pendingLocalUploads.js";

vi.mock("../src/gateway/services/tursoSyncStatus.js", () => ({
  buildTursoSyncItemsReport: vi.fn(async () => ({
    enabled: true,
    databaseMode: "per-job" as const,
    lastCheckedAt: new Date().toISOString(),
    error: null,
    sources: [],
    summary: {
      synced: 0,
      pending: 0,
      empty: 0,
      unavailable: 0,
      quarantined: 0,
      total: 0,
    },
  })),
}));

vi.mock("../src/gateway/services/tursoLinkedSources.js", () => ({
  listAppLinkedSyncKeys: vi.fn(() => []),
}));

vi.mock("../src/gateway/services/tursoSyncState.js", () => ({
  listDbDirtySyncKeysForApp: vi.fn(() => []),
}));

function mockSync(
  overrides: Partial<Pick<CloudSyncService, "getPaprDir" | "hasRelativePathChanged">> = {},
): Pick<CloudSyncService, "getPaprDir" | "hasRelativePathChanged"> {
  return {
    getPaprDir: () => "/tmp/papr-test",
    hasRelativePathChanged: () => false,
    ...overrides,
  };
}

describe("appNeedsOrderedFlushAsync", () => {
  it("returns true when git folder is dirty", async () => {
    const sync = mockSync({
      hasRelativePathChanged: (rel) => rel === "apps/app-a",
    });
    expect(appNeedsOrderedFlush(sync, "app-a")).toBe(true);
    await expect(appNeedsOrderedFlushAsync(sync, "app-a")).resolves.toBe(true);
  });

  it("returns true when linked schema drift exists even if git/db flags are clean", async () => {
    const { buildTursoSyncItemsReport } = await import(
      "../src/gateway/services/tursoSyncStatus.js"
    );
    vi.mocked(buildTursoSyncItemsReport).mockResolvedValueOnce({
      enabled: true,
      databaseMode: "per-job",
      lastCheckedAt: new Date().toISOString(),
      error: null,
      sources: [
        {
          appId: "app-a",
          jobId: "db-1",
          alias: "provenance",
          role: "linked",
          dbPath: "/tmp/data.db",
          tursoDatabase: "d-1",
          status: "pending",
          localTableCount: 3,
          remoteTableCount: 3,
          schemaDrift: true,
          quarantinedAt: null,
          quarantineReason: null,
        },
      ],
      summary: {
        synced: 0,
        pending: 1,
        empty: 0,
        unavailable: 0,
        quarantined: 0,
        total: 1,
      },
    });

    const sync = mockSync();
    expect(appNeedsOrderedFlush(sync, "app-a")).toBe(false);
    await expect(appNeedsOrderedFlushAsync(sync, "app-a")).resolves.toBe(true);
  });
});
