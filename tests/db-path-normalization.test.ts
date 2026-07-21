import { afterEach, describe, expect, test } from "vitest";
import { execSync } from "child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  findStrayDatabaseFiles,
  normalizeAppDatabases,
} from "../src/gateway/services/dbPathNormalization.js";
import { serializeDataSourcesFile } from "../src/gateway/services/appDataSources.js";
import { resetAppServiceSingletonForTests } from "../src/gateway/services/AppService.js";
import { resetJobsServiceSingletonForTests } from "../src/gateway/services/JobsService.js";

describe("dbPathNormalization", () => {
  let originalHome: string | undefined;
  let testHomeDir: string;

  afterEach(async () => {
    resetAppServiceSingletonForTests();
    resetJobsServiceSingletonForTests();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    execSync(`rm -rf "${testHomeDir}"`, { stdio: "pipe" });
  });

  function setupHome(): string {
    resetAppServiceSingletonForTests();
    resetJobsServiceSingletonForTests();
    originalHome = process.env.HOME;
    testHomeDir = join(tmpdir(), `papr-db-norm-${Date.now()}`);
    process.env.HOME = testHomeDir;
    mkdirSync(join(testHomeDir, "Papr", "apps"), { recursive: true });
    mkdirSync(join(testHomeDir, "Papr", "jobs"), { recursive: true });
    mkdirSync(join(testHomeDir, "Papr", "data"), { recursive: true });
    writeFileSync(join(testHomeDir, "Papr", "data", "apps.json"), "[]");
    writeFileSync(join(testHomeDir, "Papr", "data", "jobs.json"), "[]");
    return testHomeDir;
  }

  test("finds empty audit.db stub in app directory", async () => {
    setupHome();
    const appId = "app-11111111-1111-1111-1111-111111111111";
    const appDir = join(testHomeDir, "Papr", "apps", appId);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "audit.db"), "");

    const primaryDb = join(testHomeDir, "Papr", "jobs", "job-1", "data", "data.db");
    mkdirSync(join(testHomeDir, "Papr", "jobs", "job-1", "data"), {
      recursive: true,
    });
    execSync(
      `sqlite3 "${primaryDb}" "CREATE TABLE clients (id INT); INSERT INTO clients VALUES (1);"`,
      { stdio: "pipe" },
    );

    const config = {
      primary: "audit",
      sources: [
        {
          id: "job-1:audit",
          type: "sqlite" as const,
          jobId: "job-1",
          alias: "audit",
          role: "primary" as const,
          dbPath: primaryDb,
          tables: [],
          linkedAt: new Date().toISOString(),
        },
      ],
    };
    writeFileSync(
      join(appDir, "data-sources.json"),
      serializeDataSourcesFile(config),
    );
    writeFileSync(
      join(testHomeDir, "Papr", "data", "apps.json"),
      JSON.stringify([
        {
          id: appId,
          title: "Test",
          type: "mini-app",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]),
    );

    const strays = await findStrayDatabaseFiles(appId, config, primaryDb);
    const appStub = strays.find((s) => s.location === "app_dir");
    expect(appStub?.classification).toBe("empty");
    expect(appStub?.suggestedAction).toBe("delete");
  });

  test("dry-run normalize reports delete for empty stub", async () => {
    setupHome();
    const appId = "app-22222222-2222-2222-2222-222222222222";
    const appDir = join(testHomeDir, "Papr", "apps", appId);
    mkdirSync(appDir, { recursive: true });
    const stubPath = join(appDir, "audit.db");
    writeFileSync(stubPath, "");

    const primaryDb = join(testHomeDir, "Papr", "jobs", "job-2", "data", "data.db");
    mkdirSync(join(testHomeDir, "Papr", "jobs", "job-2", "data"), {
      recursive: true,
    });
    execSync(`sqlite3 "${primaryDb}" "CREATE TABLE t(id INT);"`, {
      stdio: "pipe",
    });

    writeFileSync(
      join(appDir, "data-sources.json"),
      serializeDataSourcesFile({
        primary: "audit",
        sources: [
          {
            id: "job-2:audit",
            type: "sqlite",
            jobId: "job-2",
            alias: "audit",
            role: "primary",
            dbPath: primaryDb,
            tables: [],
            linkedAt: new Date().toISOString(),
          },
        ],
      }),
    );
    writeFileSync(
      join(testHomeDir, "Papr", "data", "apps.json"),
      JSON.stringify([
        {
          id: appId,
          title: "Test",
          type: "mini-app",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]),
    );

    const report = await normalizeAppDatabases(appId, { dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.actions.some((a) => a.action === "delete")).toBe(true);
    expect(existsSync(stubPath)).toBe(true);
  });

  test("apply deletes empty app-folder stub", async () => {
    setupHome();
    const appId = "app-33333333-3333-3333-3333-333333333333";
    const appDir = join(testHomeDir, "Papr", "apps", appId);
    mkdirSync(appDir, { recursive: true });
    const stubPath = join(appDir, "audit.db");
    writeFileSync(stubPath, "");

    const primaryDb = join(testHomeDir, "Papr", "jobs", "job-3", "data", "data.db");
    mkdirSync(join(testHomeDir, "Papr", "jobs", "job-3", "data"), {
      recursive: true,
    });
    execSync(`sqlite3 "${primaryDb}" "CREATE TABLE t(id INT);"`, {
      stdio: "pipe",
    });

    writeFileSync(
      join(appDir, "data-sources.json"),
      serializeDataSourcesFile({
        primary: "audit",
        sources: [
          {
            id: "job-3:audit",
            type: "sqlite",
            jobId: "job-3",
            alias: "audit",
            role: "primary",
            dbPath: primaryDb,
            tables: [],
            linkedAt: new Date().toISOString(),
          },
        ],
      }),
    );
    writeFileSync(
      join(testHomeDir, "Papr", "data", "apps.json"),
      JSON.stringify([
        {
          id: appId,
          title: "Test",
          type: "mini-app",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]),
    );

    const report = await normalizeAppDatabases(appId, { dryRun: false });
    expect(report.actions.some((a) => a.action === "delete" && a.success)).toBe(
      true,
    );
    expect(existsSync(stubPath)).toBe(false);
  });
});
