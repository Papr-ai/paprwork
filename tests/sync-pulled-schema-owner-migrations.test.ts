import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const APP_ID = "app-schema-owner";
const SLUG = "sqa-talent-assessment";

const mockListBySchemaOwnerApp = vi.fn((appId: string) => {
  if (appId !== APP_ID) {
    return [];
  }
  return [
    {
      dbId: "db-test1234",
      localPath: `/tmp/Papr/data/databases/${SLUG}/data.db`,
      tursoShortName: "d-test1234",
      isolation: "shared" as const,
      status: "active" as const,
      schemaOwnerAppId: APP_ID,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
});

const mockApplyRegistryDatabaseMigrations = vi.fn(async () => [
  "0007_job_function_repair.sql",
]);

vi.mock("../src/gateway/services/DatabaseRegistryService.js", () => ({
  getDatabaseRegistryService: () => ({
    listBySchemaOwnerApp: mockListBySchemaOwnerApp,
  }),
  registrySlugFromLocalPath: (localPath: string) => {
    const match = localPath
      .replace(/\\/g, "/")
      .match(/\/data\/databases\/([^/]+)\/data\.db$/);
    return match?.[1] ?? null;
  },
}));

vi.mock("../src/gateway/services/jobs/databaseMigrations.js", () => ({
  applyRegistryDatabaseMigrations: (...args: unknown[]) =>
    mockApplyRegistryDatabaseMigrations(...args),
}));

import {
  applyRegistryMigrationsAfterPull,
  parseRepoSchemaMigrationPath,
  persistPulledSchemaMigration,
} from "../src/gateway/services/syncV3/syncPulledSchemaOwnerMigrations.js";

describe("parseRepoSchemaMigrationPath", () => {
  it("parses databases/{slug}/migrations/*.sql repo paths", () => {
    expect(
      parseRepoSchemaMigrationPath(
        "databases/sqa-talent-assessment/migrations/0007_job_function_repair.sql",
      ),
    ).toEqual({
      slug: "sqa-talent-assessment",
      fileName: "0007_job_function_repair.sql",
    });
  });

  it("returns null for non-migration paths", () => {
    expect(parseRepoSchemaMigrationPath("metadata.json")).toBeNull();
    expect(parseRepoSchemaMigrationPath("jobs/worker/code/run.py")).toBeNull();
    expect(
      parseRepoSchemaMigrationPath("apps/foo/databases/bar/migrations/0001.sql"),
    ).toBeNull();
  });
});

describe("persistPulledSchemaMigration", () => {
  let tmpDir = "";

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it("copies missing migration into data/databases/{slug}/migrations/", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "papr-pull-mig-"));

    const outcome = await persistPulledSchemaMigration({
      appId: APP_ID,
      repoPath: `databases/${SLUG}/migrations/0007_job_function_repair.sql`,
      content: "ALTER TABLE csms ADD COLUMN job_function TEXT;",
      remoteOid: "remote-oid-7",
      lastSyncedOid: null,
      paprRoot: tmpDir,
    });

    expect(outcome).toEqual({
      kind: "written",
      registryRelativePath: `data/databases/${SLUG}/migrations/0007_job_function_repair.sql`,
    });

    const onDisk = await fs.readFile(
      path.join(
        tmpDir,
        "data",
        "databases",
        SLUG,
        "migrations",
        "0007_job_function_repair.sql",
      ),
      "utf8",
    );
    expect(onDisk).toContain("job_function");
  });

  it("does not overwrite an existing registry migration file", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "papr-pull-mig-"));
    const targetDir = path.join(tmpDir, "data", "databases", SLUG, "migrations");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(
      path.join(targetDir, "0007_job_function_repair.sql"),
      "-- local copy\n",
      "utf8",
    );

    const outcome = await persistPulledSchemaMigration({
      appId: APP_ID,
      repoPath: `databases/${SLUG}/migrations/0007_job_function_repair.sql`,
      content: "ALTER TABLE csms ADD COLUMN job_function TEXT;",
      remoteOid: "remote-oid-7",
      lastSyncedOid: null,
      paprRoot: tmpDir,
    });

    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("already on disk");
    }
  });

  it("skips when app is not schema owner for slug", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "papr-pull-mig-"));

    const outcome = await persistPulledSchemaMigration({
      appId: "other-app",
      repoPath: `databases/${SLUG}/migrations/0007_job_function_repair.sql`,
      content: "ALTER TABLE csms ADD COLUMN job_function TEXT;",
      remoteOid: "remote-oid-7",
      lastSyncedOid: null,
      paprRoot: tmpDir,
    });

    expect(outcome).toEqual({
      kind: "skipped",
      reason: "not schema owner for slug",
    });
  });
});

describe("applyRegistryMigrationsAfterPull", () => {
  it("delegates to applyRegistryDatabaseMigrations for owned dbs", async () => {
    mockApplyRegistryDatabaseMigrations.mockClear();

    const applied = await applyRegistryMigrationsAfterPull(APP_ID);
    expect(applied).toEqual([`${SLUG}:0007_job_function_repair.sql`]);
    expect(mockApplyRegistryDatabaseMigrations).toHaveBeenCalledWith(
      `/tmp/Papr/data/databases/${SLUG}/data.db`,
    );
  });
});
