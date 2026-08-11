import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  pullTursoToLocalDb,
  ensureLocalDbChangeLogReady,
  pushLocalDbToTurso,
  createRemoteClient,
  localDbHasSyncableUserTables,
} = vi.hoisted(() => ({
  pullTursoToLocalDb: vi.fn(),
  ensureLocalDbChangeLogReady: vi.fn(),
  pushLocalDbToTurso: vi.fn(),
  createRemoteClient: vi.fn(),
  localDbHasSyncableUserTables: vi.fn(() => true),
}));

const applyPendingDatabaseMigrationsToTurso = vi.hoisted(() => vi.fn());
const alignMigrationLedgers = vi.hoisted(() => vi.fn());
const pushLinkedSourceWithDesktopParity = vi.hoisted(() => vi.fn());

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ size: 4096 })),
}));

vi.mock("../src/gateway/services/tursoSyncBridgeCore.js", () => ({
  pullTursoToLocalDb,
  ensureLocalDbChangeLogReady,
  pushLocalDbToTurso,
  createRemoteClient,
  localDbHasSyncableUserTables,
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

vi.mock("../src/gateway/services/jobs/jobMigrationLedgerSync.js", () => ({
  alignMigrationLedgers,
}));

vi.mock("../src/gateway/services/tursoSyncState.js", () => ({
  loadTursoSyncState: vi.fn(() => ({
    jobs: {
      "db-abc": { lastPulledLogId: 316, lastSeenRemoteVersion: 18 },
    },
  })),
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

vi.mock("../src/gateway/services/tursoLinkedSourcePush.js", () => ({
  pushLinkedSourceWithDesktopParity,
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
    vi.mocked(localDbHasSyncableUserTables).mockReturnValue(true);
    pullTursoToLocalDb.mockResolvedValue({ status: "pulled" });
    pushLinkedSourceWithDesktopParity.mockResolvedValue({
      status: "pushed",
      tables: ["audits"],
      syncMode: "delta",
    });
    createRemoteClient.mockReturnValue({
      execute: vi.fn(),
      close: vi.fn(),
    });
    applyPendingDatabaseMigrationsToTurso.mockResolvedValue([]);
    alignMigrationLedgers.mockResolvedValue({
      remoteBackfilled: [],
      localHydrated: [],
      localInferred: [],
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
    expect(alignMigrationLedgers).not.toHaveBeenCalled();
  });

  it("aligns migration ledgers after pull when registry layout is recognized", async () => {
    const target = {
      syncKey: "db-abc",
      dbPath: "/tmp/Papr/data/databases/gtm-audit/data.db",
      tursoUrl: "libsql://example.turso.io",
      authToken: "token",
    };

    await pullLinkedSourceFromCloud(target);

    expect(alignMigrationLedgers).toHaveBeenCalledOnce();
  });

  it("ignores git sync cursors when local db has no user tables yet", async () => {
    vi.mocked(localDbHasSyncableUserTables).mockReturnValue(false);

    await pullLinkedSourceFromCloud({
      syncKey: "db-abc",
      dbPath: "/tmp/sandbox/data.db",
      tursoUrl: "libsql://example.turso.io",
      authToken: "token",
    });

    const pullOptions = pullTursoToLocalDb.mock.calls[0]?.[2];
    expect(pullOptions).toEqual({ jobId: "db-abc" });
    expect(pullOptions).not.toHaveProperty("lastPulledLogId");
    expect(pullOptions).not.toHaveProperty("lastSeenRemoteVersion");
  });

  it("returns full PushResult from pushLinkedSourceToCloud", async () => {
    pushLinkedSourceWithDesktopParity.mockResolvedValue({
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
    expect(pushLinkedSourceWithDesktopParity).toHaveBeenCalledOnce();
  });

  it("delegates push to desktop-parity helper with sync state", async () => {
    await pushLinkedSourceToCloud({
      syncKey: "db-abc",
      dbPath: "/tmp/Papr/data/databases/gtm-audit/data.db",
      tursoUrl: "libsql://example.turso.io",
      authToken: "token",
    });

    expect(pushLinkedSourceWithDesktopParity).toHaveBeenCalledWith(
      expect.objectContaining({
        syncKey: "db-abc",
        dbPath: "/tmp/Papr/data/databases/gtm-audit/data.db",
        credentials: {
          tursoUrl: "libsql://example.turso.io",
          authToken: "token",
        },
        state: {},
      }),
    );
  });
});
