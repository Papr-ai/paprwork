import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PullResult, PushResult } from "../src/gateway/services/tursoSyncBridgeCore.js";
import type { TursoLinkedSource } from "../src/gateway/services/tursoLinkedSources.js";
import {
  isLinkedSourceLocallyDirty,
  reconcileLinkedSourcesFromCloud,
  resolveSyncKeysForCloudPull,
  syncLinkedSourceFromCloud,
  type TursoCloudSyncBridge,
} from "../src/gateway/services/tursoSyncSession.js";

const linked: TursoLinkedSource = {
  appId: "app-1",
  jobId: "job-abc",
  dbPath: "/tmp/job/data.db",
  sourceId: "primary",
  role: "primary",
};

const pushResult: PushResult = {
  status: "pushed",
  tables: ["items"],
  syncMode: "delta",
};

const pullResult: PullResult = {
  status: "pulled",
  tables: ["items"],
  syncMode: "delta",
};

function makeBridge(overrides?: Partial<TursoCloudSyncBridge>): TursoCloudSyncBridge {
  return {
    enabled: true,
    listLinkedSources: vi.fn(async () => [linked]),
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

const listDbDirtySyncKeysMock = vi.fn<(...args: unknown[]) => string[]>(
  () => [],
);

vi.mock("../src/gateway/services/tursoSyncState.js", () => ({
  loadTursoSyncState: vi.fn(() => ({ jobs: {} })),
  isJobDbDirty: vi.fn(() => false),
  resolveTursoPushStateEntry: vi.fn(() => ({})),
  listDbDirtySyncKeysForApp: (...args: unknown[]) =>
    listDbDirtySyncKeysMock(...args),
}));

// Code-pending git state must be irrelevant to row pulls; mock stays only so
// other modules importing it still resolve.
vi.mock("../src/gateway/services/cloudSync/pendingLocalUploads.js", () => ({
  readAppHasPendingLocalUpload: vi.fn(() => true),
}));

vi.mock("../src/gateway/services/tursoReplica/tursoReplicaRouting.js", () => ({
  shouldUseTursoReplicaForSource: vi.fn(() => false),
  syncStatusForLinkedDb: vi.fn(async () => ({ pendingPush: false })),
}));

vi.mock("../src/core/utils/paprRoot.js", () => ({
  getPaprRoot: vi.fn(() => "/tmp/papr-turso-sync-session-test"),
}));

import { remoteAheadOfLocal } from "../src/gateway/services/tursoSyncBridgeCore.js";
import { isJobDbDirty } from "../src/gateway/services/tursoSyncState.js";
import { readAppHasPendingLocalUpload } from "../src/gateway/services/cloudSync/pendingLocalUploads.js";
import {
  shouldUseTursoReplicaForSource,
  syncStatusForLinkedDb,
} from "../src/gateway/services/tursoReplica/tursoReplicaRouting.js";

describe("tursoSyncSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isJobDbDirty).mockReturnValue(false);
    vi.mocked(remoteAheadOfLocal).mockResolvedValue(false);
    vi.mocked(readAppHasPendingLocalUpload).mockReturnValue(false);
    listDbDirtySyncKeysMock.mockReset();
    listDbDirtySyncKeysMock.mockReturnValue([]);
    vi.mocked(shouldUseTursoReplicaForSource).mockReturnValue(false);
    vi.mocked(syncStatusForLinkedDb).mockResolvedValue({ pendingPush: false });
  });

  it("resolveSyncKeysForCloudPull scopes by appId", () => {
    const keys = resolveSyncKeysForCloudPull([linked], { appId: "app-1" });
    expect(keys).toEqual(["job-abc"]);
  });

  it("resolveSyncKeysForCloudPull scopes by jobId", () => {
    const keys = resolveSyncKeysForCloudPull([linked], { jobId: "job-abc" });
    expect(keys).toEqual(["job-abc"]);
  });

  it("skips pull when local clean and remote unchanged", async () => {
    const bridge = makeBridge();
    const result = await syncLinkedSourceFromCloud(bridge, "job-abc", {
      trigger: "app_open",
    });

    expect(result.action).toBe("skipped");
    expect(result.reason).toBe("remote_unchanged");
    expect(bridge.pullJob).not.toHaveBeenCalled();
    expect(bridge.pushJob).not.toHaveBeenCalled();
  });

  it("pulls when local clean and remote ahead", async () => {
    vi.mocked(remoteAheadOfLocal).mockResolvedValue(true);
    const bridge = makeBridge();
    const result = await syncLinkedSourceFromCloud(bridge, "job-abc");

    expect(result.action).toBe("pulled");
    expect(bridge.pullJob).toHaveBeenCalledWith("job-abc");
    expect(bridge.pushJob).not.toHaveBeenCalled();
  });

  it("pulls when app CODE has pending git upload (code state must not gate row pulls)", async () => {
    // Regression: the old gate used the app folder git hash, which silently
    // disabled cloud→local row pulls for every app with any local source edit.
    vi.mocked(readAppHasPendingLocalUpload).mockReturnValue(true);
    vi.mocked(remoteAheadOfLocal).mockResolvedValue(true);
    const bridge = makeBridge();
    const result = await syncLinkedSourceFromCloud(bridge, "job-abc");

    expect(result.action).toBe("pulled");
    expect(bridge.pullJob).toHaveBeenCalledWith("job-abc");
  });

  it("skips pull when this DB has unpushed local rows — before any remote check", async () => {
    listDbDirtySyncKeysMock.mockReturnValue(["job-abc"]);
    vi.mocked(remoteAheadOfLocal).mockResolvedValue(true);
    const bridge = makeBridge();
    const result = await syncLinkedSourceFromCloud(bridge, "job-abc");

    expect(result.action).toBe("skipped");
    expect(result.reason).toBe("pending_local_db_push");
    expect(bridge.pullJob).not.toHaveBeenCalled();
    // Gate short-circuits before the remote-ahead network round-trip.
    expect(remoteAheadOfLocal).not.toHaveBeenCalled();
  });

  it("preferRemote pulls even when app has pending local git upload", async () => {
    vi.mocked(readAppHasPendingLocalUpload).mockReturnValue(true);
    const bridge = makeBridge();
    const result = await syncLinkedSourceFromCloud(bridge, "job-abc", {
      preferRemote: true,
      trigger: "manual",
    });

    expect(result.action).toBe("pulled");
    expect(bridge.pullJob).toHaveBeenCalledWith("job-abc", undefined, {
      forceReconnect: true,
    });
    expect(bridge.pushJob).not.toHaveBeenCalled();
  });

  it("pulls when assumeRemoteChanged without remote check", async () => {
    const bridge = makeBridge();
    await syncLinkedSourceFromCloud(bridge, "job-abc", {
      assumeRemoteChanged: true,
    });

    expect(remoteAheadOfLocal).not.toHaveBeenCalled();
    expect(bridge.pullJob).toHaveBeenCalledOnce();
  });

  it("pushes when local dirty (pushJob includes post-pull)", async () => {
    vi.mocked(isJobDbDirty).mockReturnValue(true);
    const bridge = makeBridge();
    const result = await syncLinkedSourceFromCloud(bridge, "job-abc");

    expect(result.action).toBe("pushed");
    expect(bridge.pushJob).toHaveBeenCalledWith("job-abc");
    expect(bridge.pullJob).not.toHaveBeenCalled();
  });

  it("reconcileLinkedSourcesFromCloud returns empty when bridge disabled", async () => {
    const bridge = makeBridge({ enabled: false });
    const results = await reconcileLinkedSourcesFromCloud(bridge);
    expect(results).toEqual([]);
  });

  it("reconcileLinkedSourcesFromCloud runs scoped sessions", async () => {
    vi.mocked(remoteAheadOfLocal).mockResolvedValue(true);
    const bridge = makeBridge();
    const results = await reconcileLinkedSourcesFromCloud(
      bridge,
      { appId: "app-1" },
      { trigger: "post_cloud_run" },
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe("pulled");
    expect(results[0]?.trigger).toBe("post_cloud_run");
  });

  it("assumeRemoteChanged on replica pulls even when legacy fingerprint dirty", async () => {
    vi.mocked(shouldUseTursoReplicaForSource).mockReturnValue(true);
    vi.mocked(isJobDbDirty).mockReturnValue(true);
    vi.mocked(syncStatusForLinkedDb).mockResolvedValue({ pendingPush: false });
    const bridge = makeBridge();
    const result = await syncLinkedSourceFromCloud(bridge, "job-abc", {
      assumeRemoteChanged: true,
      trigger: "cloud_db_changed",
    });

    expect(result.action).toBe("pulled");
    expect(bridge.pullJob).toHaveBeenCalledWith("job-abc", undefined, {
      forceReconnect: true,
    });
    expect(bridge.pushJob).not.toHaveBeenCalled();
  });

  it("isLinkedSourceLocallyDirty delegates to fingerprint state for legacy", async () => {
    vi.mocked(isJobDbDirty).mockReturnValue(true);
    expect(await isLinkedSourceLocallyDirty(linked)).toBe(true);
  });

  it("isLinkedSourceLocallyDirty uses replica pendingPush when replica mode", async () => {
    vi.mocked(shouldUseTursoReplicaForSource).mockReturnValue(true);
    vi.mocked(syncStatusForLinkedDb).mockResolvedValue({ pendingPush: true });
    vi.mocked(isJobDbDirty).mockReturnValue(true);
    expect(await isLinkedSourceLocallyDirty(linked)).toBe(true);
    expect(isJobDbDirty).not.toHaveBeenCalled();
  });
});
