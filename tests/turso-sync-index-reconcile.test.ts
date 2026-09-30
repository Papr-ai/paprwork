import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullResult, PushResult } from "../src/gateway/services/tursoSyncBridgeCore.js";
import type { TursoLinkedSource } from "../src/gateway/services/tursoLinkedSources.js";
import {
  reconcileFromSyncIndex,
  isTursoStartupSyncIndexEnabled,
  resetTursoSyncSessionStatsForTests,
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
    listLinkedSources: vi.fn(async () => [jobLinked]),
    pushJob: vi.fn(async () => pushResult),
    pullJob: vi.fn(async () => pullResult),
    resolveTursoDatabaseNameForLinked: vi.fn(async () => "j-jobabc"),
    fetchCredentials: vi.fn(async () => ({
      tursoUrl: "libsql://example.turso.io",
      authToken: "token",
    })),
    runExclusiveForDbPath: vi.fn(async (_dbPath, fn) => fn()),
    ...overrides,
  };
}

vi.mock("../src/gateway/services/tursoSyncIndex.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/gateway/services/tursoSyncIndex.js")
  >();
  return {
    ...actual,
    loadSyncIndexSnapshot: vi.fn(),
  };
});

vi.mock("../src/gateway/services/tursoSyncState.js", () => ({
  isJobDbDirty: vi.fn(() => false),
  loadTursoSyncState: vi.fn(() => ({ jobs: {} })),
  resolveTursoPushStateEntry: vi.fn(() => ({ lastSeenIndexVersion: 0 })),
  recordTursoIndexVersion: vi.fn(),
  listDbDirtySyncKeysForApp: vi.fn(() => []),
}));

vi.mock("../src/gateway/services/tursoReplica/tursoReplicaRouting.js", () => ({
  shouldUseTursoReplicaForSource: vi.fn(() => false),
  syncStatusForLinkedDb: vi.fn(async () => ({ pendingPush: false })),
}));

vi.mock("../src/core/utils/paprRoot.js", () => ({
  getPaprRoot: vi.fn(() => "/tmp/papr-turso-sync-index-test"),
}));

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

describe("reconcileFromSyncIndex", () => {
  beforeEach(async () => {
    resetTursoSyncSessionStatsForTests();
    vi.clearAllMocks();
    const { remoteAheadOfLocal } = await import(
      "../src/gateway/services/tursoSyncBridgeCore.js"
    );
    vi.mocked(remoteAheadOfLocal).mockResolvedValue(false);
  });

  it("reconciles linked sources whose index version advanced and remote is ahead", async () => {
    const { loadSyncIndexSnapshot } = await import(
      "../src/gateway/services/tursoSyncIndex.js"
    );
    const { remoteAheadOfLocal } = await import(
      "../src/gateway/services/tursoSyncBridgeCore.js"
    );
    vi.mocked(loadSyncIndexSnapshot).mockResolvedValue([
      { shortName: "j-jobabc", version: 3, updatedAt: "2026-01-01" },
    ]);
    vi.mocked(remoteAheadOfLocal).mockResolvedValue(true);

    const bridge = makeBridge();

    const results = await reconcileFromSyncIndex(bridge, { trigger: "sync_index" });
    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe("pulled");
    expect(bridge.pullJob).toHaveBeenCalledWith("job-abc");
    expect(bridge.pullJob).not.toHaveBeenCalledWith(
      "job-abc",
      undefined,
      expect.objectContaining({ forceReconnect: true }),
    );
  });

  it("records index cursor when remote is unchanged (no force reconnect pull)", async () => {
    const { loadSyncIndexSnapshot } = await import(
      "../src/gateway/services/tursoSyncIndex.js"
    );
    const { recordTursoIndexVersion } = await import(
      "../src/gateway/services/tursoSyncState.js"
    );
    vi.mocked(loadSyncIndexSnapshot).mockResolvedValue([
      { shortName: "j-jobabc", version: 3, updatedAt: "2026-01-01" },
    ]);

    const bridge = makeBridge();

    const results = await reconcileFromSyncIndex(bridge);
    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe("skipped");
    expect(results[0]?.reason).toBe("remote_unchanged");
    expect(bridge.pullJob).not.toHaveBeenCalled();
    expect(recordTursoIndexVersion).toHaveBeenCalledWith(
      "job-abc",
      jobLinked.dbPath,
      3,
    );
  });

  it("dedupes multiple app links to the same sync key", async () => {
    const { loadSyncIndexSnapshot } = await import(
      "../src/gateway/services/tursoSyncIndex.js"
    );
    const { remoteAheadOfLocal } = await import(
      "../src/gateway/services/tursoSyncBridgeCore.js"
    );
    vi.mocked(loadSyncIndexSnapshot).mockResolvedValue([
      { shortName: "j-jobabc", version: 2, updatedAt: "2026-01-01" },
    ]);
    vi.mocked(remoteAheadOfLocal).mockResolvedValue(true);

    const secondLink: TursoLinkedSource = {
      ...jobLinked,
      appId: "app-2",
      alias: "shared",
    };

    const bridge = makeBridge({
      listLinkedSources: vi.fn(async () => [jobLinked, secondLink]),
    });

    const results = await reconcileFromSyncIndex(bridge);
    expect(results).toHaveLength(1);
    expect(bridge.pullJob).toHaveBeenCalledTimes(1);
  });

  it("skips when index version matches lastSeenIndexVersion", async () => {
    const { loadSyncIndexSnapshot } = await import(
      "../src/gateway/services/tursoSyncIndex.js"
    );
    const { resolveTursoPushStateEntry } = await import(
      "../src/gateway/services/tursoSyncState.js"
    );
    vi.mocked(loadSyncIndexSnapshot).mockResolvedValue([
      { shortName: "j-jobabc", version: 2, updatedAt: "2026-01-01" },
    ]);
    vi.mocked(resolveTursoPushStateEntry).mockReturnValue({
      lastSeenIndexVersion: 2,
    });

    const bridge = makeBridge();

    const results = await reconcileFromSyncIndex(bridge);
    expect(results).toHaveLength(0);
    expect(bridge.pullJob).not.toHaveBeenCalled();
  });
});

describe("isTursoStartupSyncIndexEnabled", () => {
  const prev = process.env.TURSO_STARTUP_SYNC_INDEX;

  afterEach(() => {
    if (prev === undefined) {
      delete process.env.TURSO_STARTUP_SYNC_INDEX;
    } else {
      process.env.TURSO_STARTUP_SYNC_INDEX = prev;
    }
  });

  it("defaults to disabled", () => {
    delete process.env.TURSO_STARTUP_SYNC_INDEX;
    expect(isTursoStartupSyncIndexEnabled()).toBe(false);
  });

  it("enables when explicitly true", () => {
    process.env.TURSO_STARTUP_SYNC_INDEX = "true";
    expect(isTursoStartupSyncIndexEnabled()).toBe(true);
  });
});
