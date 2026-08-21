import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDataSourcesFile } from "../src/gateway/services/appDataSources.js";
import type {
  AppRuntimeRouteAuth,
  TursoCredentialsProvider,
} from "../src/gateway/services/appRuntime/types.js";

vi.mock("../src/gateway/services/appRuntime/memoryRuntimeClient.js", () => ({
  appendRuntimeWorkspaceLogBatch: vi.fn(),
  appendRuntimeWorkspaceLogEntry: vi.fn(),
}));

vi.mock("../src/gateway/services/DatabaseRegistryService.js", () => ({
  getDatabaseRegistryService: vi.fn(() => ({
    getRecordForSource: () => undefined,
  })),
  tursoNameForRecord: vi.fn(),
}));

import { TursoDbAdapter } from "../src/gateway/services/appRuntime/TursoDbAdapter.js";
import { appendRuntimeWorkspaceLogBatch } from "../src/gateway/services/appRuntime/memoryRuntimeClient.js";

const runtimeAuth: AppRuntimeRouteAuth = {
  namespaceId: "ns-1",
  slug: "test-app",
};

const config = {
  primary: "main",
  sources: [
    {
      id: "job-1:main",
      type: "sqlite" as const,
      jobId: "job-1",
      alias: "main",
      dbPath: "/tmp/data.db",
      tables: [],
      linkedAt: new Date().toISOString(),
      role: "primary" as const,
    },
  ],
} satisfies AppDataSourcesFile;

describe("TursoDbAdapter.writeBatch (Reco #4)", () => {
  beforeEach(() => {
    process.env.PAPR_CLOUD_APP_HOST_KEY = "test-host-key";
  });

  afterEach(() => {
    delete process.env.PAPR_CLOUD_APP_HOST_KEY;
    vi.clearAllMocks();
  });

  it("groups statements by replica and calls append-batch once", async () => {
    vi.mocked(appendRuntimeWorkspaceLogBatch).mockResolvedValue({
      replicaId: "j-job1",
      firstSeq: 1,
      lastSeq: 3,
      count: 3,
      hlc: "2026-01-01T00:00:00Z",
      latencyMs: 42,
    });

    const adapter = new TursoDbAdapter({
      getUserDatabaseToken: vi.fn(),
    } as unknown as TursoCredentialsProvider);

    const source = config.sources[0];
    vi.spyOn(adapter, "resolveSource").mockResolvedValue({
      source,
      remoteSql: "INSERT INTO t (n) VALUES (?)",
    });
    vi.spyOn(
      adapter as unknown as { resolveTursoDatabaseName: () => Promise<string> },
      "resolveTursoDatabaseName",
    ).mockResolvedValue("j-job1");

    const result = await adapter.writeBatch({
      orgId: "org-1",
      namespaceId: "ns-1",
      userId: "user-1",
      runtimeAuth,
      config,
      appId: "app-1",
      statements: [
        { sql: "INSERT INTO t (n) VALUES (?)", params: [1] },
        { sql: "INSERT INTO t (n) VALUES (?)", params: [2] },
        { sql: "INSERT INTO t (n) VALUES (?)", params: [3] },
      ],
    });

    expect(appendRuntimeWorkspaceLogBatch).toHaveBeenCalledTimes(1);
    const batchArg = vi.mocked(appendRuntimeWorkspaceLogBatch).mock.calls[0]?.[1];
    expect(batchArg?.replicaId).toBe("j-job1");
    expect(batchArg?.entries).toHaveLength(3);
    expect(result.results).toHaveLength(3);
    expect(result.results.every((row) => row.ok === true)).toBe(true);
    expect(result.results.every((row) => row.source === "main")).toBe(true);
  });

  it("rejects more than MAX_WRITE_BATCH statements", async () => {
    const adapter = new TursoDbAdapter({
      getUserDatabaseToken: vi.fn(),
    } as unknown as TursoCredentialsProvider);

    const statements = Array.from({ length: TursoDbAdapter.MAX_WRITE_BATCH + 1 }, () => ({
      sql: "INSERT INTO t (n) VALUES (?)",
      params: [1],
    }));

    await expect(
      adapter.writeBatch({
        orgId: "org-1",
        namespaceId: "ns-1",
        userId: "user-1",
        runtimeAuth,
        config,
        appId: "app-1",
        statements,
      }),
    ).rejects.toThrow(/Batch limited to 25/);
  });
});
