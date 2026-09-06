import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DbRouter,
  isLocalDbReadable,
  resetDbRouterTursoCache,
} from "../src/gateway/services/appRuntime/DbRouter.js";
import type { AppDataSource } from "../src/gateway/services/appDataSources.js";
import type { DbQueryPool } from "../src/gateway/services/DbQueryPool.js";

const mockQueryLinkedDbViaTursoReplica = vi.fn();
const mockShouldUseTursoReplicaForSource = vi.fn();
const mockReplicaClose = vi.fn(async () => undefined);
const mockGetTursoReplicaService = vi.fn(() => ({
  close: mockReplicaClose,
}));

vi.mock("../src/gateway/services/tursoReplica/TursoReplicaService.js", () => ({
  getTursoReplicaService: () => mockGetTursoReplicaService(),
}));

vi.mock("../src/gateway/services/DatabaseRegistryService.js", () => ({
  resolveTursoDatabaseNameForSource: () => null,
}));

vi.mock("../src/gateway/services/tursoReplica/tursoReplicaRouting.js", () => ({
  queryLinkedDbViaTursoReplica: (...args: unknown[]) =>
    mockQueryLinkedDbViaTursoReplica(...args),
  recoverReplicaAfterCheckpointError: vi.fn(),
  schemaLinkedDbViaTursoReplica: vi.fn(),
  shouldUseTursoReplicaForSource: (...args: unknown[]) =>
    mockShouldUseTursoReplicaForSource(...args),
}));

describe("isLocalDbReadable", () => {
  it("returns false for missing file", () => {
    expect(isLocalDbReadable("/tmp/does-not-exist-db-router.db")).toBe(false);
  });

  it("returns true for non-empty sqlite file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "db-router-"));
    const dbPath = path.join(tmpDir, "data.db");
    fs.writeFileSync(dbPath, "sqlite");
    expect(isLocalDbReadable(dbPath)).toBe(true);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("DbRouter", () => {
  const source: AppDataSource = {
    id: "job-1:main",
    type: "sqlite",
    jobId: "job-1",
    alias: "main",
    dbPath: "/tmp/missing/data.db",
    tables: [],
    linkedAt: new Date().toISOString(),
  };

  let pool: DbQueryPool;

  beforeEach(() => {
    resetDbRouterTursoCache();
    mockShouldUseTursoReplicaForSource.mockReturnValue(false);
    mockQueryLinkedDbViaTursoReplica.mockReset();
    mockReplicaClose.mockClear();
    pool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: 1 }],
        columns: ["id"],
        count: 1,
      }),
      schema: vi.fn().mockResolvedValue({ tables: [] }),
      write: vi.fn(),
      exec: vi.fn(),
      tableExists: vi.fn().mockResolvedValue(true),
      terminate: vi.fn(),
    } as unknown as DbQueryPool;
  });

  afterEach(() => {
    resetDbRouterTursoCache();
  });

  it("uses local pool when db file exists", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "db-router-local-"));
    const dbPath = path.join(tmpDir, "data.db");
    fs.writeFileSync(dbPath, "sqlite");
    const localSource = { ...source, dbPath };
    const router = new DbRouter(pool);

    const result = await router.query("app-1", localSource, "SELECT 1", []);
    expect(result.backend).toBe("local");
    expect(pool.query).toHaveBeenCalledWith("app-1", dbPath, "SELECT 1", []);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects writes when local db is missing", async () => {
    const router = new DbRouter(pool);
    await expect(
      router.write("app-1", source, "INSERT INTO t VALUES (1)", []),
    ).rejects.toThrow(/Cannot write/);
  });

  it("uses turso replica sync engine for replica sources", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "db-router-replica-"));
    const dbPath = path.join(tmpDir, "data.db");
    fs.writeFileSync(dbPath, "sqlite");
    const replicaSource: AppDataSource = {
      ...source,
      dbId: "db-test",
      dbPath,
      alias: "sqa",
    };

    mockShouldUseTursoReplicaForSource.mockReturnValue(true);
    mockQueryLinkedDbViaTursoReplica.mockResolvedValue({
      rows: [{ id: 1 }],
      columns: ["id"],
      count: 1,
    });

    const router = new DbRouter(pool);
    const result = await router.query("app-1", replicaSource, "SELECT 1", []);

    expect(result.backend).toBe("turso-replica");
    expect(pool.query).not.toHaveBeenCalled();
    expect(mockQueryLinkedDbViaTursoReplica).toHaveBeenCalledWith(
      replicaSource,
      "SELECT 1",
      [],
      { pullBeforeRead: false },
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("times out mini-app replica reads when local db is missing", async () => {
    const replicaSource: AppDataSource = {
      ...source,
      dbId: "db-test",
      alias: "sqa",
    };

    mockShouldUseTursoReplicaForSource.mockReturnValue(true);
    mockQueryLinkedDbViaTursoReplica.mockRejectedValue(
      new Error("replica read (sqa) timed out after 2500ms"),
    );

    const router = new DbRouter(pool);
    await expect(
      router.query("app-1", replicaSource, "SELECT 1", []),
    ).rejects.toThrow(/timed out/);

    expect(mockQueryLinkedDbViaTursoReplica).toHaveBeenCalledTimes(2);
    expect(pool.query).not.toHaveBeenCalled();
    expect(mockReplicaClose).not.toHaveBeenCalled();
  });
});
