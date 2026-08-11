import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PullResult, PushResult } from "../src/gateway/services/tursoSyncBridgeCore.js";
import type { TursoLinkedSource } from "../src/gateway/services/tursoLinkedSources.js";
import {
  reconcileFromCloudDbChanges,
  resolveSyncKeysFromCloudDbChanges,
  resetTursoSyncSessionStatsForTests,
  getTursoSyncSessionStatsForTests,
  type TursoCloudSyncBridge,
} from "../src/gateway/services/tursoSyncSession.js";

const jobLinked: TursoLinkedSource = {
  appId: "app-1",
  jobId: "job-abc",
  dbPath: "/tmp/job/data.db",
  sourceId: "primary",
  alias: "main",
  role: "primary",
};

const registryLinked: TursoLinkedSource = {
  appId: "app-1",
  dbId: "db-registry-1",
  dbPath: "/tmp/Papr/data/databases/gtm/data.db",
  sourceId: "registry",
  alias: "gtm",
  role: "primary",
};

const pullResult: PullResult = {
  status: "pulled",
  tables: ["items"],
  syncMode: "delta",
};

const pushResult: PushResult = {
  status: "pushed",
  tables: ["items"],
  syncMode: "delta",
};

function makeBridge(overrides?: Partial<TursoCloudSyncBridge>): TursoCloudSyncBridge {
  return {
    enabled: true,
    listLinkedSources: vi.fn(async () => [jobLinked, registryLinked]),
    pushJob: vi.fn(async () => pushResult),
    pullJob: vi.fn(async () => pullResult),
    resolveTursoDatabaseNameForLinked: vi.fn(async () => "j-jobabc"),
    fetchCredentials: vi.fn(async () => ({
      tursoUrl: "libsql://example.turso.io",
      authToken: "token",
    })),
    ...overrides,
  };
}

vi.mock("../src/gateway/services/tursoSyncBridgeCore.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/gateway/services/tursoSyncBridgeCore.js")
  >();
  return {
    ...actual,
    createRemoteClient: vi.fn(() => ({
      execute: vi.fn(),
      close: vi.fn(),
    })),
    remoteAheadOfLocal: vi.fn(async () => false),
  };
});

vi.mock("../src/gateway/services/tursoSyncState.js", () => ({
  loadTursoSyncState: vi.fn(() => ({ jobs: {} })),
  isJobDbDirty: vi.fn(() => false),
  resolveTursoPushStateEntry: vi.fn(() => ({})),
}));

describe("resolveSyncKeysFromCloudDbChanges", () => {
  it("resolves dbId to registry sync key", () => {
    const keys = resolveSyncKeysFromCloudDbChanges(
      [registryLinked],
      [{ dbId: "db-registry-1" }],
    );
    expect(keys).toEqual(["db-registry-1"]);
  });

  it("expands jobId to writeDbIds for registry sources", () => {
    const writeDbIds = new Map<string, readonly string[]>([
      ["job-abc", ["db-registry-1", "job-abc"]],
    ]);
    const keys = resolveSyncKeysFromCloudDbChanges(
      [jobLinked, registryLinked],
      [{ jobId: "job-abc" }],
      writeDbIds,
    );
    expect(keys.sort()).toEqual(["db-registry-1", "job-abc"].sort());
  });

  it("dedupes duplicate notifications", () => {
    const keys = resolveSyncKeysFromCloudDbChanges(
      [registryLinked],
      [{ dbId: "db-registry-1" }, { dbId: "db-registry-1" }],
    );
    expect(keys).toEqual(["db-registry-1"]);
  });
});

describe("reconcileFromCloudDbChanges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTursoSyncSessionStatsForTests();
  });

  it("pulls each matched source with assumeRemoteChanged", async () => {
    const bridge = makeBridge();
    const results = await reconcileFromCloudDbChanges(
      bridge,
      [{ dbId: "db-registry-1" }, { jobId: "job-abc" }],
    );

    expect(results).toHaveLength(2);
    expect(bridge.pullJob).toHaveBeenCalledTimes(2);
    expect(bridge.pushJob).not.toHaveBeenCalled();
    expect(getTursoSyncSessionStatsForTests().byTrigger.cloud_db_changed).toBe(2);
  });

  it("returns empty when bridge disabled", async () => {
    const bridge = makeBridge({ enabled: false });
    const results = await reconcileFromCloudDbChanges(bridge, [
      { dbId: "db-registry-1" },
    ]);
    expect(results).toEqual([]);
  });

  it("skips unknown dbId without error", async () => {
    const bridge = makeBridge();
    const results = await reconcileFromCloudDbChanges(bridge, [
      { dbId: "db-missing" },
    ]);
    expect(results).toEqual([]);
    expect(bridge.pullJob).not.toHaveBeenCalled();
  });
});
