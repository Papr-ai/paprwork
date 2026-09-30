import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AppDataSource } from "../src/gateway/services/appDataSources.js";
import type { DbQueryPool } from "../src/gateway/services/DbQueryPool.js";
import type { DbRouter } from "../src/gateway/services/appRuntime/DbRouter.js";

describe("local-first db write", () => {
  const source: AppDataSource = {
    id: "primary",
    type: "sqlite",
    alias: "primary",
    dbPath: "/tmp/test/data.db",
    tables: ["items"],
    linkedAt: "",
    jobId: "job-local-first",
  };

  const pool = {
    write: vi.fn(async () => ({ changes: 1, lastInsertRowid: 42 })),
    exec: vi.fn(async () => undefined),
  } as unknown as DbQueryPool;

  const dbRouter = {
    write: vi.fn(async () => ({ changes: 1, lastInsertRowid: 42 })),
    exec: vi.fn(async () => undefined),
  } as unknown as DbRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CLOUD_SYNC_ENABLED;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    delete process.env.CLOUD_SYNC_ENABLED;
  });

  test("cloud sync off writes local SQLite only (no log ship)", async () => {
    process.env.CLOUD_SYNC_ENABLED = "false";

    vi.doMock("../src/gateway/services/tursoSyncBridgeCore.js", () => ({
      ensureLocalDbChangeLogReady: vi.fn(),
    }));

    const { writeLinkedDbRowLocalFirst } = await import(
      "../src/gateway/services/syncV3/localFirstDbWrite.js"
    );

    const result = await writeLinkedDbRowLocalFirst(
      pool,
      dbRouter,
      "app-1",
      source,
      "INSERT INTO items (name) VALUES (?)",
      ["alpha"],
    );

    expect(result.changes).toBe(1);
    expect(result.cloudSyncScheduled).toBe(false);
    expect(pool.write).toHaveBeenCalledOnce();
    expect(dbRouter.write).not.toHaveBeenCalled();
  });

  test("cloud sync on writes local first and schedules workspace log ship", async () => {
    process.env.CLOUD_SYNC_ENABLED = "true";

    const scheduleTursoPushForJob = vi.fn();
    vi.doMock("../src/gateway/services/tursoPushScheduler.js", () => ({
      scheduleTursoPushForJob,
    }));

    const { writeLinkedDbRowLocalFirst } = await import(
      "../src/gateway/services/syncV3/localFirstDbWrite.js"
    );

    const result = await writeLinkedDbRowLocalFirst(
      pool,
      dbRouter,
      "app-1",
      source,
      "INSERT INTO items (name) VALUES (?)",
      ["beta"],
    );

    expect(result.cloudSyncScheduled).toBe(true);
    expect(dbRouter.write).toHaveBeenCalledOnce();
    expect(pool.write).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduleTursoPushForJob).toHaveBeenCalledWith(
      "job-local-first",
      "completion",
      "api_write",
    );
  });
});

describe("isWorkspaceLogRowsEnabled", () => {
  afterEach(() => {
    delete process.env.CLOUD_SYNC_ENABLED;
  });

  test("follows CLOUD_SYNC_ENABLED", async () => {
    const { isWorkspaceLogRowsEnabled } = await import(
      "../src/gateway/services/syncV3/LogMaterializer.js"
    );

    process.env.CLOUD_SYNC_ENABLED = "false";
    expect(isWorkspaceLogRowsEnabled()).toBe(false);

    delete process.env.CLOUD_SYNC_ENABLED;
    expect(isWorkspaceLogRowsEnabled()).toBe(true);
  });
});

describe("isCloudSyncEnabled", () => {
  afterEach(() => {
    delete process.env.CLOUD_SYNC_ENABLED;
  });

  test("defaults to enabled unless explicitly false", async () => {
    const { isCloudSyncEnabled } = await import(
      "../src/gateway/utils/cloudSyncEnabled.js"
    );

    expect(isCloudSyncEnabled()).toBe(true);
    process.env.CLOUD_SYNC_ENABLED = "false";
    expect(isCloudSyncEnabled()).toBe(false);
  });
});
