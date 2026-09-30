import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

const getPrimaryDataSource = vi.fn();
const initialize = vi.fn();
const getById = vi.fn();
const existsSync = vi.fn();

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: (...args: Parameters<typeof actual.existsSync>) =>
      existsSync(...args),
  };
});

vi.mock("../src/gateway/services/AppService.js", () => ({
  getAppService: () => ({ initialize, getPrimaryDataSource }),
}));

vi.mock("../src/gateway/services/DatabaseRegistryService.js", () => ({
  initializeDatabaseRegistry: vi.fn(async () => ({
    getById,
  })),
}));

import {
  databaseEnvKey,
  jobWriteDatabaseEnv,
  requireJobWriteTargets,
  resolveExistingRegistryDbPath,
  resolveJobAppDatabase,
  resolveJobWriteTargets,
  validateWriteDbIdsExist,
} from "../src/gateway/services/jobAppDatabase.js";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

describe("job write database resolution", () => {
  // Keeps fixtures out of the developer's real ~/Papr workspace.
  useIsolatedPaprWorkspace("job-app-database");

  beforeEach(() => {
    initialize.mockReset();
    getPrimaryDataSource.mockReset();
    getById.mockReset();
    existsSync.mockReset();
    existsSync.mockReturnValue(true);
  });

  it("returns empty targets for standalone jobs without writeDbIds", async () => {
    await expect(
      resolveJobWriteTargets({ appIds: ["__standalone__"] }),
    ).resolves.toEqual([]);
  });

  it("resolves writeDbIds from registry", async () => {
    getById.mockReturnValue({
      dbId: "db-billing",
      label: "Billing",
      localPath: "/tmp/billing/data.db",
      status: "active",
    });

    const targets = await resolveJobWriteTargets({
      writeDbIds: ["db-billing"],
      appIds: ["app-1"],
    });

    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      dbId: "db-billing",
      alias: "Billing",
      dbPath: "/tmp/billing/data.db",
      envKey: "BILLING",
    });
  });

  it("injects multi-DB env vars", () => {
    const env = jobWriteDatabaseEnv(
      [
        {
          dbId: "db-a",
          alias: "metrics",
          dbPath: "/tmp/metrics.db",
          envKey: "METRICS",
        },
        {
          dbId: "db-b",
          alias: "billing",
          dbPath: "/tmp/billing.db",
          envKey: "BILLING",
        },
      ],
      "app-1",
    );

    expect(env.PAPR_DB_METRICS).toBe("/tmp/metrics.db");
    expect(env.PAPR_DB_BILLING).toBe("/tmp/billing.db");
    expect(env.PAPR_DB_METRICS_MODE).toBe("local");
    expect(env.PAPR_WRITE_DB_IDS).toBe("db-a,db-b");
    expect(env.APP_DB).toBe("/tmp/metrics.db");
    expect(env.APP_ID).toBe("app-1");
  });

  it("resolves writeDbIds via turso creds in cloud sandbox without local file", async () => {
    getById.mockReturnValue({
      dbId: "db-billing",
      label: "Billing",
      localPath: "/tmp/missing/billing.db",
      status: "active",
    });
    existsSync.mockReturnValue(false);

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "papr-turso-direct-"));
    const paprHome = path.join(tempRoot, "papr-cloud-run", "run1", "Papr");
    await fs.mkdir(paprHome, { recursive: true });

    const originalPaprHome = process.env.PAPR_HOME;
    const originalReplicaSync = process.env.PAPR_TURSO_REPLICA_SYNC;
    process.env.PAPR_HOME = paprHome;
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";

    try {
      const targets = await resolveJobWriteTargets(
        { writeDbIds: ["db-billing"], appIds: ["app-1"] },
        {
          tursoCredsByDbId: new Map([
            [
              "db-billing",
              { url: "libsql://billing.turso.io", authToken: "tok" },
            ],
          ]),
        },
      );

      expect(targets).toEqual([
        expect.objectContaining({
          dbId: "db-billing",
          turso: {
            url: "libsql://billing.turso.io",
            authToken: "tok",
          },
        }),
      ]);
    } finally {
      if (originalPaprHome === undefined) delete process.env.PAPR_HOME;
      else process.env.PAPR_HOME = originalPaprHome;
      if (originalReplicaSync === undefined) delete process.env.PAPR_TURSO_REPLICA_SYNC;
      else process.env.PAPR_TURSO_REPLICA_SYNC = originalReplicaSync;
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("legacy fallback uses job-linked sqlite when primary has jobId but no dbId", async () => {
    getPrimaryDataSource.mockResolvedValue({
      id: "job-abc:Daily Brief Generator (job-abc)",
      jobId: "job-abc-uuid",
      alias: "Daily Brief Generator (job-abc)",
      dbPath: "/tmp/brief/data.db",
    });

    await expect(resolveJobWriteTargets({ appIds: ["app-123"] })).resolves.toEqual([
      expect.objectContaining({
        dbId: "job-abc-uuid",
        dbPath: "/tmp/brief/data.db",
        alias: "Daily Brief Generator (job-abc)",
      }),
    ]);
  });

  it("legacy fallback uses app primary linked source", async () => {
    getPrimaryDataSource.mockResolvedValue({
      dbId: "db-legacy",
      alias: "primary",
      dbPath: "/tmp/legacy/data.db",
    });
    getById.mockReturnValue({
      dbId: "db-legacy",
      label: "primary",
      localPath: "/tmp/legacy/data.db",
      status: "active",
    });

    await expect(resolveJobWriteTargets({ appIds: ["app-123"] })).resolves.toEqual([
      expect.objectContaining({
        dbId: "db-legacy",
        dbPath: "/tmp/legacy/data.db",
      }),
    ]);
  });

  it("requireJobWriteTargets throws when app job writes SQL without writeDbIds", async () => {
    getPrimaryDataSource.mockResolvedValue(null);

    await expect(
      requireJobWriteTargets({
        appIds: ["app-new"],
        command: 'sqlite3 "$APP_DB" "INSERT INTO t VALUES (1)"',
        type: "python",
      }),
    ).rejects.toThrow(/no writeDbIds/i);
  });

  it("validateWriteDbIdsExist rejects unknown dbId", async () => {
    getById.mockReturnValue(null);
    await expect(validateWriteDbIdsExist(["db-missing"])).rejects.toThrow(
      /not found in registry/i,
    );
  });

  it("databaseEnvKey falls back to dbId when label empty", () => {
    expect(databaseEnvKey({ dbId: "db-abc-123", label: "" })).toBe(
      "DB_ABC_123",
    );
  });

  it("resolveJobAppDatabase returns legacy shape from primary fallback", async () => {
    getPrimaryDataSource.mockResolvedValue({
      dbId: "db-x",
      alias: "orders",
      dbPath: "/tmp/orders.db",
    });
    getById.mockReturnValue({
      dbId: "db-x",
      label: "orders",
      localPath: "/tmp/orders.db",
      status: "active",
    });

    await expect(resolveJobAppDatabase(["app-1"])).resolves.toEqual({
      appId: "app-1",
      appDb: "/tmp/orders.db",
      appDbAlias: "orders",
    });
  });

  it("resolves stale desktop registry path from cloud sandbox workspace", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "papr-job-db-"));
    const paprHome = path.join(
      tempRoot,
      "Papr",
      "orgs",
      "org1",
      "namespaces",
      "ns1",
    );
    const workspaceDb = path.join(
      paprHome,
      "data",
      "databases",
      "gtm-audit",
      "data.db",
    );
    await fs.mkdir(path.dirname(workspaceDb), { recursive: true });
    await fs.writeFile(workspaceDb, "sqlite");

    const storedPath =
      "/Users/me/Papr/orgs/org1/namespaces/ns1/data/databases/gtm-audit/data.db";

    getById.mockReturnValue({
      dbId: "db-gtm",
      label: "GTM Audit",
      localPath: storedPath,
      status: "active",
    });

    const originalPaprHome = process.env.PAPR_HOME;
    const originalGatewayMode = process.env.GATEWAY_MODE;
    const originalHome = process.env.HOME;
    process.env.HOME = tempRoot;
    process.env.PAPR_HOME = paprHome;
    process.env.GATEWAY_MODE = "cloud_agent";

    try {
      existsSync.mockImplementation((candidate: Parameters<typeof existsSync>[0]) => {
        const resolved = path.resolve(String(candidate));
        return resolved === workspaceDb;
      });

      const targets = await resolveJobWriteTargets({
        writeDbIds: ["db-gtm"],
        appIds: ["app-1"],
      });

      expect(targets).toEqual([
        expect.objectContaining({
          dbId: "db-gtm",
          dbPath: workspaceDb,
        }),
      ]);
      expect(resolveExistingRegistryDbPath(storedPath)).toBe(workspaceDb);
    } finally {
      if (originalPaprHome === undefined) {
        delete process.env.PAPR_HOME;
      } else {
        process.env.PAPR_HOME = originalPaprHome;
      }
      if (originalGatewayMode === undefined) {
        delete process.env.GATEWAY_MODE;
      } else {
        process.env.GATEWAY_MODE = originalGatewayMode;
      }
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
