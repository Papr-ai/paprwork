import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  pullTursoToLocalDb,
  ensureLocalDbChangeLogReady,
  pushLocalDbToTurso,
  createRemoteClient,
} = vi.hoisted(() => ({
  pullTursoToLocalDb: vi.fn(),
  ensureLocalDbChangeLogReady: vi.fn(),
  pushLocalDbToTurso: vi.fn(),
  createRemoteClient: vi.fn(),
}));

vi.mock("../src/gateway/services/tursoSyncBridgeCore.js", () => ({
  pullTursoToLocalDb,
  ensureLocalDbChangeLogReady,
  pushLocalDbToTurso,
  createRemoteClient,
}));

vi.mock("../src/gateway/services/tursoSyncState.js", () => ({
  loadTursoSyncState: () => ({ jobs: {} }),
  localDbHasSyncableData: () => true,
}));

vi.mock("../src/gateway/services/tursoDeltaSync.js", () => ({
  remoteNeedsBootstrap: vi.fn().mockResolvedValue(false),
}));

import {
  pullLinkedSourceFromCloud,
  pushLinkedSourceToCloud,
} from "../src/gateway/services/cloudAgentGateway/syncJobTursoBookends.js";

describe("cloud agent Turso bookends", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pullTursoToLocalDb.mockResolvedValue({ status: "pulled" });
    pushLocalDbToTurso.mockResolvedValue({
      status: "pushed",
      tables: ["audits"],
      syncMode: "delta",
    });
    createRemoteClient.mockReturnValue({
      execute: vi.fn(),
      close: vi.fn(),
    });
  });

  it("installs changelog triggers after pulling from Turso", async () => {
    const target = {
      syncKey: "db-abc",
      dbPath: "/tmp/sandbox/data.db",
      tursoUrl: "libsql://example.turso.io",
      authToken: "token",
    };

    await pullLinkedSourceFromCloud(target);

    expect(pullTursoToLocalDb).toHaveBeenCalledOnce();
    expect(ensureLocalDbChangeLogReady).toHaveBeenCalledWith(target.dbPath);
  });

  it("returns full PushResult from pushLinkedSourceToCloud", async () => {
    pushLocalDbToTurso.mockResolvedValue({
      status: "pushed",
      tables: ["audit_modules"],
      syncMode: "snapshot_fallback",
    });

    const result = await pushLinkedSourceToCloud({
      syncKey: "db-abc",
      dbPath: "/tmp/sandbox/data.db",
      tursoUrl: "libsql://example.turso.io",
      authToken: "token",
    });

    expect(result.status).toBe("pushed");
    expect(result.syncMode).toBe("snapshot_fallback");
  });
});
