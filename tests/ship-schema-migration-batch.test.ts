import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TursoLinkedSource } from "../src/gateway/services/tursoLinkedSources.js";

vi.mock("../src/gateway/services/syncV3/syncV3Flags.js", () => ({
  isSyncV3SchemaLogEnabled: () => true,
}));

vi.mock("../src/gateway/services/syncV3/workspaceLogSync.js", () => ({
  resolveReplicaIdForLinkedSource: () => "db-test1234",
}));

vi.mock("../src/gateway/services/jobs/databaseMigrations.js", () => ({
  resolveMigrationRootFromDbPath: () => "/tmp/migrations-root",
}));

vi.mock("../src/gateway/services/syncV3/buildSchemaMigrationPayload.js", () => ({
  buildSchemaMigrationPayload: vi.fn(async (_root, migrationId: string) => ({
    appId: "app-1",
    dbSlug: "primary",
    migrationId,
    contentHash: `hash-${migrationId}`,
    statements: [`ALTER TABLE t ADD COLUMN ${migrationId}`],
  })),
}));

const appendWorkspaceLogBatch = vi.fn(async () => ({
  replicaId: "db-test1234",
  firstSeq: 1,
  lastSeq: 2,
  count: 2,
  hlc: "2026-01-01T00:00:00Z",
  latencyMs: 100,
  schemaAppliedCount: 2,
}));

vi.mock("../src/gateway/services/syncV3/WorkspaceLogClient.js", () => ({
  appendWorkspaceLogBatch: (...args: unknown[]) => appendWorkspaceLogBatch(...args),
  appendWorkspaceLogEntry: vi.fn(),
  appendWorkspaceLogEntryWithApiKey: vi.fn(),
}));

describe("shipSchemaMigrationBatch", () => {
  const linked = {
    appId: "app-1",
    alias: "primary",
    dbId: "db-test1234",
    dbPath: "/tmp/data.db",
    jobId: undefined,
  } as TursoLinkedSource;

  beforeEach(() => {
    appendWorkspaceLogBatch.mockClear();
  });

  it("ships migrations and heal ops in one append-batch", async () => {
    const { shipSchemaMigrationBatch } = await import(
      "../src/gateway/services/syncV3/shipSchemaMigrationLog.js"
    );

    const shipped = await shipSchemaMigrationBatch(
      linked,
      linked.dbPath,
      ["0016_add_foo", "0017_add_bar"],
      [{ kind: "add_column", table: "t", column: "x", sqlType: "TEXT" }],
    );

    expect(shipped).toBe(3);
    expect(appendWorkspaceLogBatch).toHaveBeenCalledTimes(1);
    const request = appendWorkspaceLogBatch.mock.calls[0]?.[0] as {
      replicaId: string;
      entries: Array<{ kind: string; payload: { migrationId?: string } }>;
    };
    expect(request.replicaId).toBe("db-test1234");
    expect(request.entries).toHaveLength(3);
    expect(request.entries[0]?.payload.migrationId).toBe("0016_add_foo");
    expect(request.entries[1]?.payload.migrationId).toBe("0017_add_bar");
    expect(request.entries[2]?.payload.migrationId).toMatch(
      /^__schema_drift_heal___/,
    );

    const options = appendWorkspaceLogBatch.mock.calls[0]?.[1] as {
      timeoutMs: number;
    };
    expect(options.timeoutMs).toBeGreaterThanOrEqual(180_000);
  });
});
