import { beforeEach, describe, expect, it, vi } from "vitest";

const pullLinkedSourceViaWorkspaceLog = vi.hoisted(() => vi.fn());
const pushLinkedSourceViaWorkspaceLog = vi.hoisted(() => vi.fn());
const ensureLocalDbChangeLogReady = vi.hoisted(() => vi.fn());
const localDbHasSyncableUserTables = vi.hoisted(() => vi.fn(() => true));
const alignMigrationLedgers = vi.hoisted(() => vi.fn());

vi.mock("../src/gateway/services/syncV3/workspaceLogSync.js", () => ({
  pullLinkedSourceViaWorkspaceLog,
  pushLinkedSourceViaWorkspaceLog,
}));

vi.mock("../src/gateway/services/tursoSyncBridgeCore.js", () => ({
  ensureLocalDbChangeLogReady,
  localDbHasSyncableUserTables,
  createRemoteClient: vi.fn(() => ({
    close: vi.fn(),
  })),
}));

vi.mock("../src/gateway/services/tursoSyncState.js", () => ({
  loadTursoSyncState: vi.fn(() => ({
    jobs: {
      "db-abc": { lastPulledLogId: 316, lastSeenRemoteVersion: 18 },
    },
  })),
}));

vi.mock("../src/gateway/services/jobs/jobMigrationTursoSync.js", () => ({
  resolveMigrationRootFromDbPath: vi.fn((dbPath: string) => {
    if (dbPath.includes("/data/databases/")) {
      return dbPath.replace(/\/data\.db$/, "");
    }
    return null;
  }),
}));

vi.mock("../src/gateway/services/jobs/jobMigrationLedgerSync.js", () => ({
  alignMigrationLedgers,
}));

vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn(() => true),
  },
  existsSync: vi.fn(() => true),
}));

import {
  pullLinkedSourceFromCloud,
  pushLinkedSourceToCloud,
} from "../src/gateway/services/cloudAgentGateway/syncJobTursoBookends.js";

describe("cloud agent Turso bookends", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(localDbHasSyncableUserTables).mockReturnValue(true);
    pullLinkedSourceViaWorkspaceLog.mockResolvedValue({ status: "pulled", tables: ["*"] });
    pushLinkedSourceViaWorkspaceLog.mockResolvedValue({
      status: "pushed",
      tables: ["audits"],
    });
    alignMigrationLedgers.mockResolvedValue({
      remoteBackfilled: [],
      localHydrated: [],
      localInferred: [],
    });
  });

  it("materializes workspace log after pull", async () => {
    const target = {
      syncKey: "db-abc",
      dbPath: "/tmp/sandbox/data.db",
      tursoUrl: "libsql://example.turso.io",
      authToken: "token",
      appId: "app-1",
      dbId: "db-abc",
    };

    await pullLinkedSourceFromCloud(target);

    expect(pullLinkedSourceViaWorkspaceLog).toHaveBeenCalledOnce();
    expect(ensureLocalDbChangeLogReady).toHaveBeenCalledWith(target.dbPath);
    expect(alignMigrationLedgers).not.toHaveBeenCalled();
  });

  it("aligns migration ledgers after pull when registry layout is recognized", async () => {
    const target = {
      syncKey: "db-abc",
      dbPath: "/tmp/Papr/data/databases/gtm-audit/data.db",
      tursoUrl: "libsql://example.turso.io",
      authToken: "token",
      appId: "app-1",
      dbId: "db-abc",
    };

    await pullLinkedSourceFromCloud(target);

    expect(alignMigrationLedgers).toHaveBeenCalledOnce();
  });

  it("skips workspace log pull when appId is missing", async () => {
    vi.mocked(localDbHasSyncableUserTables).mockReturnValue(false);
    vi.stubEnv("APP_ID", "");

    await pullLinkedSourceFromCloud({
      syncKey: "db-abc",
      dbPath: "/tmp/sandbox/data.db",
      tursoUrl: "libsql://example.turso.io",
      authToken: "token",
    });

    expect(pullLinkedSourceViaWorkspaceLog).not.toHaveBeenCalled();
    expect(ensureLocalDbChangeLogReady).toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("returns full PushResult from pushLinkedSourceToCloud", async () => {
    pushLinkedSourceViaWorkspaceLog.mockResolvedValue({
      status: "pushed",
      tables: ["audit_modules"],
    });

    const result = await pushLinkedSourceToCloud({
      syncKey: "db-abc",
      dbPath: "/tmp/sandbox/data.db",
      tursoUrl: "libsql://example.turso.io",
      authToken: "token",
      appId: "app-1",
      dbId: "db-abc",
    });

    expect(result.status).toBe("pushed");
    expect(pushLinkedSourceViaWorkspaceLog).toHaveBeenCalledOnce();
  });

  it("fails push when appId is missing", async () => {
    vi.stubEnv("APP_ID", "");

    const result = await pushLinkedSourceToCloud({
      syncKey: "db-abc",
      dbPath: "/tmp/sandbox/data.db",
      tursoUrl: "libsql://example.turso.io",
      authToken: "token",
    });

    vi.unstubAllEnvs();

    expect(result.status).toBe("failed");
    expect(result.error).toContain("appId");
  });
});
