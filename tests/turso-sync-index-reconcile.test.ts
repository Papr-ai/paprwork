import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PullResult, PushResult } from "../src/gateway/services/tursoSyncBridgeCore.js";
import type { TursoLinkedSource } from "../src/gateway/services/tursoLinkedSources.js";
import {
  reconcileFromSyncIndex,
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
  beforeEach(() => {
    resetTursoSyncSessionStatsForTests();
    vi.clearAllMocks();
  });

  it("reconciles linked sources whose index version advanced", async () => {
    const { loadSyncIndexSnapshot } = await import(
      "../src/gateway/services/tursoSyncIndex.js"
    );
    vi.mocked(loadSyncIndexSnapshot).mockResolvedValue([
      { shortName: "j-jobabc", version: 3, updatedAt: "2026-01-01" },
    ]);

    const bridge: TursoCloudSyncBridge = {
      enabled: true,
      listLinkedSources: vi.fn(async () => [jobLinked]),
      pushJob: vi.fn(async () => pushResult),
      pullJob: vi.fn(async () => pullResult),
      resolveTursoDatabaseNameForLinked: vi.fn(async () => "j-jobabc"),
      fetchCredentials: vi.fn(async () => ({
        tursoUrl: "libsql://example.turso.io",
        authToken: "token",
      })),
    };

    const results = await reconcileFromSyncIndex(bridge, { trigger: "sync_index" });
    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe("pulled");
    expect(bridge.pullJob).toHaveBeenCalledWith("job-abc");
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

    const bridge: TursoCloudSyncBridge = {
      enabled: true,
      listLinkedSources: vi.fn(async () => [jobLinked]),
      pushJob: vi.fn(async () => pushResult),
      pullJob: vi.fn(async () => pullResult),
      resolveTursoDatabaseNameForLinked: vi.fn(async () => "j-jobabc"),
      fetchCredentials: vi.fn(async () => ({
        tursoUrl: "libsql://example.turso.io",
        authToken: "token",
      })),
    };

    const results = await reconcileFromSyncIndex(bridge);
    expect(results).toHaveLength(0);
    expect(bridge.pullJob).not.toHaveBeenCalled();
  });
});
