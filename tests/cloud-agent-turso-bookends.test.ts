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

const applyPendingDatabaseMigrationsToTurso = vi.hoisted(() => vi.fn());

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ size: 4096 })),
}));

vi.mock("../src/gateway/services/tursoSyncBridgeCore.js", () => ({
  pullTursoToLocalDb,
  ensureLocalDbChangeLogReady,
  pushLocalDbToTurso,
  createRemoteClient,
}));

vi.mock("../src/gateway/services/jobs/jobMigrationTursoSync.js", () => ({
  applyPendingDatabaseMigrationsToTurso,
  resolveMigrationRootFromDbPath: vi.fn((dbPath: string) => {
    if (dbPath.includes("/data/databases/")) {
      return dbPath.replace(/\/data\.db$/, "");
    }
    if (dbPath.includes("/data/data.db")) {
      return dbPath.replace(/\/data\/data\.db$/, "");
    }
    return null;
  }),
}));

vi.mock("../src/gateway/services/tursoSyncState.js", () => ({
  loadTursoSyncState: () => ({ jobs: {} }),
  localDbHasSyncableData: () => true,
}));

vi.mock("fs", () => ({
  default: {
    existsSync: fsMocks.existsSync,
    statSync: fsMocks.statSync,
  },
  existsSync: fsMocks.existsSync,
  statSync: fsMocks.statSync,
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
    applyPendingDatabaseMigrationsToTurso.mockResolvedValue([]);
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

  it("replays database migrations before pushing when local db has data", async () => {
    await pushLinkedSourceToCloud({
      syncKey: "db-abc",
      dbPath: "/tmp/Papr/data/databases/gtm-audit/data.db",
      tursoUrl: "libsql://example.turso.io",
      authToken: "token",
    });

    expect(applyPendingDatabaseMigrationsToTurso).toHaveBeenCalledOnce();
    expect(pushLocalDbToTurso).toHaveBeenCalledOnce();
  });
});
