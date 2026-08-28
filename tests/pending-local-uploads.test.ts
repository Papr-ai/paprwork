import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudSyncService } from "../src/gateway/services/CloudSyncService.js";
import {
  appHasReplicaPendingPush,
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
  listAppLinkedSyncKeys: vi.fn(() => new Set<string>()),
  discoverTursoLinkedSources: vi.fn(async () => []),
  linkedSourceAsAppDataSource: vi.fn(
    (source: {
      appId: string;
      alias: string;
      dbPath: string;
      jobId: string;
    }) => ({
      appId: source.appId,
      alias: source.alias,
      dbPath: source.dbPath,
      dbId: source.jobId,
      jobId: source.jobId,
    }),
  ),
}));

vi.mock("../src/gateway/services/tursoReplica/tursoReplicaRouting.js", () => ({
  shouldUseTursoReplicaForSource: vi.fn(() => true),
  syncStatusForLinkedDb: vi.fn(async () => ({
    online: true,
    syncMode: "replica" as const,
    pendingPush: false,
    pendingOps: 0,
    lastPushError: null,
    migrationConflict: false,
    cutoverBlocked: false,
    cutoverBlockReason: null,
    stats: null,
  })),
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
  afterEach(() => {
    vi.clearAllMocks();
  });

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
    const { listAppLinkedSyncKeys } = await import(
      "../src/gateway/services/tursoLinkedSources.js"
    );
    vi.mocked(listAppLinkedSyncKeys).mockReturnValue(new Set(["db-1"]));
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

  it("returns true when Plan A replica has pending CDC ops even if git is clean", async () => {
    const { discoverTursoLinkedSources } = await import(
      "../src/gateway/services/tursoLinkedSources.js"
    );
    const { syncStatusForLinkedDb } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaRouting.js"
    );

    vi.mocked(discoverTursoLinkedSources).mockResolvedValue([
      {
        appId: "app-a",
        jobId: "db-caf671ba",
        alias: "todos",
        dbPath: "/tmp/todos/data.db",
        role: "linked",
        tables: ["todos"],
      },
    ]);
    vi.mocked(syncStatusForLinkedDb).mockResolvedValue({
      online: true,
      syncMode: "replica",
      pendingPush: true,
      pendingOps: 5,
      lastPushError: null,
      migrationConflict: false,
      cutoverBlocked: false,
      cutoverBlockReason: null,
      stats: null,
    });

    const sync = mockSync();
    expect(appNeedsOrderedFlush(sync, "app-a")).toBe(false);
    await expect(appHasReplicaPendingPush("app-a", "/tmp/papr-test")).resolves.toBe(
      true,
    );
    await expect(appNeedsOrderedFlushAsync(sync, "app-a")).resolves.toBe(true);
  });
});
