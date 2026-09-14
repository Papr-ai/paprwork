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
  hydrateAppFolderSchemaMigrationsToRegistry,
  parseAppRelativeSchemaMigrationPath,
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

describe("parseAppRelativeSchemaMigrationPath", () => {
  it("parses databases/{slug}/migrations under app folder", () => {
    expect(
      parseAppRelativeSchemaMigrationPath(
        "databases/lead-prospector/migrations/0001_init.sql",
      ),
    ).toEqual({
      slug: "lead-prospector",
      fileName: "0001_init.sql",
      repoStylePath: "databases/lead-prospector/migrations/0001_init.sql",
    });
  });

  it("parses full apps/{id}/databases/... paths", () => {
    expect(
      parseAppRelativeSchemaMigrationPath(
        "apps/d97ad90c-e2d0-4022-9f1a-8b1c2d3e4f5a/databases/lead-prospector/migrations/0002_add.sql",
      )?.fileName,
    ).toBe("0002_add.sql");
  });
});

describe("hydrateAppFolderSchemaMigrationsToRegistry", () => {
  let tmpDir = "";

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it("mirrors SQL from apps/{id}/databases/{slug}/migrations into registry", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "papr-hydrate-mig-"));
    const appsRoot = path.join(tmpDir, "apps");
    const appDir = path.join(appsRoot, APP_ID, "databases", SLUG, "migrations");
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(
      path.join(appDir, "0001_init.sql"),
      "CREATE TABLE leads (id TEXT PRIMARY KEY);",
      "utf8",
    );

    const result = await hydrateAppFolderSchemaMigrationsToRegistry({
      appId: APP_ID,
      paprRoot: tmpDir,
      appsRoot,
    });

    expect(result.copied).toEqual([
      `data/databases/${SLUG}/migrations/0001_init.sql`,
    ]);
    const onDisk = await fs.readFile(
      path.join(tmpDir, "data", "databases", SLUG, "migrations", "0001_init.sql"),
      "utf8",
    );
    expect(onDisk).toContain("CREATE TABLE leads");
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
