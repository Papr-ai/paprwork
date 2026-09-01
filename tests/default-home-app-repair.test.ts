import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";
import {
  DEFAULT_HOME_APP_ID,
  DEFAULT_HOME_DAILY_BRIEF_JOB_ID,
  repairDefaultHomeAppLinkedSources,
} from "../src/gateway/services/defaultHomeAppRepair.js";
import { detectSchemaMigrationsLayout } from "../src/gateway/services/jobs/schemaMigrationsLedger.js";

describe("defaultHomeAppRepair", () => {
  let tmpDir: string;
  let appsDir: string;
  let jobsRoot: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "home-repair-"));
    appsDir = path.join(tmpDir, "apps");
    jobsRoot = path.join(tmpDir, "Jobs");
    await fs.mkdir(path.join(appsDir, DEFAULT_HOME_APP_ID), { recursive: true });
    await fs.mkdir(
      path.join(jobsRoot, DEFAULT_HOME_DAILY_BRIEF_JOB_ID, "data"),
      { recursive: true },
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("prunes data-sources for missing jobs and upgrades legacy schema_migrations", async () => {
    const briefDb = path.join(
      jobsRoot,
      DEFAULT_HOME_DAILY_BRIEF_JOB_ID,
      "data",
      "data.db",
    );
    const db = new Database(briefDb);
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, applied_at) VALUES (1, '2026-01-01');
      CREATE TABLE briefs (date TEXT PRIMARY KEY, brief_json TEXT NOT NULL);
    `);
    db.close();

    await fs.writeFile(
      path.join(appsDir, DEFAULT_HOME_APP_ID, "data-sources.json"),
      JSON.stringify(
        [
          {
            id: "missing:orphan",
            type: "sqlite",
            jobId: "00000000-0000-0000-0000-000000000099",
            alias: "orphan",
            dbPath: "",
            tables: [],
            linkedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "brief",
            type: "sqlite",
            jobId: DEFAULT_HOME_DAILY_BRIEF_JOB_ID,
            alias: "Daily Brief",
            dbPath: "",
            tables: ["briefs"],
            linkedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        null,
        2,
      ),
      "utf8",
    );

    const repair = await repairDefaultHomeAppLinkedSources({
      appsDir,
      jobExists: (jobId) => jobId === DEFAULT_HOME_DAILY_BRIEF_JOB_ID,
      resolveJobDbPath: (jobId) =>
        path.join(jobsRoot, jobId, "data", "data.db"),
    });

    expect(repair.prunedSources).toBe(1);
    expect(repair.dbPathsUpdated).toBeGreaterThanOrEqual(1);
    expect(repair.schemaRepaired).toBe(1);

    const saved = JSON.parse(
      await fs.readFile(
        path.join(appsDir, DEFAULT_HOME_APP_ID, "data-sources.json"),
        "utf-8",
      ),
    ) as Array<{ jobId?: string; dbPath?: string }>;
    const sources = Array.isArray(saved) ? saved : saved.sources;
    expect(sources).toHaveLength(1);
    expect(sources[0]?.jobId).toBe(DEFAULT_HOME_DAILY_BRIEF_JOB_ID);
    expect(sources[0]?.dbPath).toBe(briefDb);

    const verifyDb = new Database(briefDb, { readonly: true });
    expect(detectSchemaMigrationsLayout(verifyDb)).toBe("id");
    verifyDb.close();
  });

  it("upgrades stub Daily Brief data-sources with empty jobId/dbPath", async () => {
    const briefDb = path.join(
      jobsRoot,
      DEFAULT_HOME_DAILY_BRIEF_JOB_ID,
      "data",
      "data.db",
    );
    await fs.writeFile(briefDb, "sqlite stub", "utf8");

    await fs.writeFile(
      path.join(appsDir, DEFAULT_HOME_APP_ID, "data-sources.json"),
      JSON.stringify(
        {
          sources: [
            {
              id: "",
              type: "sqlite",
              jobId: "",
              alias: "Daily Brief Generator",
              dbPath: "",
              tables: ["briefs"],
              linkedAt: "2026-04-07T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const repair = await repairDefaultHomeAppLinkedSources({
      appsDir,
      workspaceRoot: tmpDir,
      jobExists: (jobId) => jobId === DEFAULT_HOME_DAILY_BRIEF_JOB_ID,
      resolveJobDbPath: (jobId) =>
        path.join(jobsRoot, jobId, "data", "data.db"),
    });

    expect(repair.dbPathsUpdated).toBeGreaterThanOrEqual(1);
    expect(repair.jobIdPersisted).toBe(1);

    const saved = JSON.parse(
      await fs.readFile(
        path.join(appsDir, DEFAULT_HOME_APP_ID, "data-sources.json"),
        "utf-8",
      ),
    ) as { sources: Array<{ jobId?: string; dbPath?: string; id?: string }> };
    expect(saved.sources).toHaveLength(1);
    expect(saved.sources[0]?.jobId).toBe(DEFAULT_HOME_DAILY_BRIEF_JOB_ID);
    expect(saved.sources[0]?.dbPath).toBe(briefDb);
    // Stable id/alias — must NOT embed the job id or job name. A job-id-derived
    // sourceId is what silently broke writes (gateway 404 returned as HTTP 200).
    expect(saved.sources[0]?.id).toBe("briefs");

    const jobIdFile = await fs.readFile(
      path.join(appsDir, DEFAULT_HOME_APP_ID, "default-job-id.txt"),
      "utf8",
    );
    expect(jobIdFile.trim()).toBe(DEFAULT_HOME_DAILY_BRIEF_JOB_ID);
  });
});
