import { beforeEach, describe, expect, it, vi } from "vitest";

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
  resolveJobAppDatabase,
  resolveJobWriteTargets,
  validateWriteDbIdsExist,
} from "../src/gateway/services/jobAppDatabase.js";

describe("job write database resolution", () => {
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
    expect(env.PAPR_WRITE_DB_IDS).toBe("db-a,db-b");
    expect(env.APP_DB).toBe("/tmp/metrics.db");
    expect(env.APP_ID).toBe("app-1");
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
});
