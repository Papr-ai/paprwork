import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildDailyBriefDataSource,
  dailyBriefDataSourceNeedsUpdate,
  DEFAULT_HOME_APP_ID,
  DEFAULT_HOME_BRIEFS_DB_SLUG,
  DEFAULT_HOME_DAILY_BRIEF_JOB_NAME,
  findHomeDailyBriefJobIdInRegistry,
  LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID,
  mergeDailyBriefDataSource,
  resolveHomeDailyBriefJobId,
  resolveOrAllocateHomeDailyBriefJobId,
  shouldRewriteDailyBriefDbPath,
} from "../src/gateway/services/defaultHomeBundle.js";
import type { JobRecord } from "../src/gateway/services/jobs/types.js";
import { validateJobArchitecture } from "../src/gateway/services/jobs/jobArchitectureValidation.js";

describe("defaultHomeBundle", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "home-bundle-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("buildDailyBriefDataSource uses a stable id/alias that never embeds the job id", () => {
    const jobId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const source = buildDailyBriefDataSource(jobId, "/tmp/data.db");
    // id === alias so both spellings of sourceId resolve to this source.
    expect(source.id).toBe("briefs");
    expect(source.alias).toBe("briefs");
    expect(source.id).toBe(source.alias);
    expect(source.jobId).toBe(jobId);
    expect(source.tables).toEqual(["briefs"]);
    // Regression: a job-id-derived alias silently broke writes when the id changed.
    expect(source.alias).not.toContain(jobId.slice(0, 8));
  });

  it("buildDailyBriefDataSource binds the registry dbId when provided", () => {
    const jobId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect(buildDailyBriefDataSource(jobId, "/tmp/data.db").dbId).toBeUndefined();
    expect(
      buildDailyBriefDataSource(jobId, "/tmp/data.db", "db-1234abcd").dbId,
    ).toBe("db-1234abcd");
  });

  it("mergeDailyBriefDataSource preserves alias when the same job is already linked", () => {
    const jobId = "6953796f-1111-2222-3333-444444444444";
    const existing = {
      id: "briefs",
      type: "sqlite" as const,
      jobId,
      alias: "briefs",
      dbPath: "/old/data.db",
      tables: ["briefs"],
      linkedAt: "2026-08-30T19:01:00.000Z",
    };
    const merged = mergeDailyBriefDataSource(
      existing,
      jobId,
      "/new/data.db",
    );
    expect(merged.alias).toBe("briefs");
    expect(merged.id).toBe("briefs");
    expect(merged.dbPath).toBe("/new/data.db");
    expect(merged.jobId).toBe(jobId);
    expect(merged.linkedAt).toBe("2026-08-30T19:01:00.000Z");
  });

  it("mergeDailyBriefDataSource uses canonical alias for a new link", () => {
    const jobId = "6953796f-1111-2222-3333-444444444444";
    const merged = mergeDailyBriefDataSource(undefined, jobId, "/data.db");
    expect(merged.alias).toBe("briefs");
    expect(merged.id).toBe("briefs");
  });

  it("mergeDailyBriefDataSource keeps the alias stable when job id changes", () => {
    const oldJobId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const newJobId = "6953796f-1111-2222-3333-444444444444";
    const existing = buildDailyBriefDataSource(oldJobId, "/old/data.db");
    const merged = mergeDailyBriefDataSource(existing, newJobId, "/new/data.db");
    // Relinking to a different job must NOT rename the source — mini-apps and
    // the brief job address it by this alias.
    expect(merged.alias).toBe("briefs");
    expect(merged.id).toBe("briefs");
    expect(merged.jobId).toBe(newJobId);
    expect(merged.dbPath).toBe("/new/data.db");
  });

  it("mergeDailyBriefDataSource adopts a registry dbId and never drops an existing one", () => {
    const jobId = "6953796f-1111-2222-3333-444444444444";
    const linked = mergeDailyBriefDataSource(
      undefined,
      jobId,
      "/data.db",
      "db-1234abcd",
    );
    expect(linked.dbId).toBe("db-1234abcd");

    // Later boots without an explicit dbId must preserve the binding.
    const preserved = mergeDailyBriefDataSource(linked, jobId, "/data.db");
    expect(preserved.dbId).toBe("db-1234abcd");
  });

  it("dailyBriefDataSourceNeedsUpdate is false when only canonical fields match", () => {
    const jobId = "6953796f-1111-2222-3333-444444444444";
    const source = {
      id: "briefs",
      type: "sqlite" as const,
      jobId,
      alias: "briefs",
      dbPath: "/data.db",
      tables: ["briefs"],
      linkedAt: "2026-08-30T19:01:00.000Z",
    };
    const merged = mergeDailyBriefDataSource(source, jobId, "/data.db");
    expect(dailyBriefDataSourceNeedsUpdate(source, merged)).toBe(false);
  });

  it("findHomeDailyBriefJobIdInRegistry prefers namespace job over legacy duplicate", () => {
    const namespaceId = "11111111-2222-3333-4444-555555555555";
    const jobs: JobRecord[] = [
      {
        id: LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID,
        name: DEFAULT_HOME_DAILY_BRIEF_JOB_NAME,
        type: "agent",
        status: "idle",
        appIds: [DEFAULT_HOME_APP_ID],
        createdAt: "",
        updatedAt: "",
      },
      {
        id: namespaceId,
        name: DEFAULT_HOME_DAILY_BRIEF_JOB_NAME,
        type: "agent",
        status: "idle",
        appIds: [DEFAULT_HOME_APP_ID],
        createdAt: "",
        updatedAt: "",
      },
    ];
    expect(findHomeDailyBriefJobIdInRegistry(jobs)).toBe(namespaceId);
    expect(
      findHomeDailyBriefJobIdInRegistry(jobs, { preferJobId: namespaceId }),
    ).toBe(namespaceId);
  });

  it("findHomeDailyBriefJobIdInRegistry matches Home-linked job by name", () => {
    const jobs: JobRecord[] = [
      {
        id: "job-other",
        name: "Other",
        type: "agent",
        status: "idle",
        appIds: [DEFAULT_HOME_APP_ID],
        createdAt: "",
        updatedAt: "",
      },
      {
        id: "job-brief",
        name: DEFAULT_HOME_DAILY_BRIEF_JOB_NAME,
        type: "agent",
        status: "idle",
        appIds: [DEFAULT_HOME_APP_ID],
        createdAt: "",
        updatedAt: "",
      },
    ];
    expect(findHomeDailyBriefJobIdInRegistry(jobs)).toBe("job-brief");
  });

  it("resolveHomeDailyBriefJobId prefers default-job-id.txt then legacy id", () => {
    const fromFile = "11111111-2222-3333-4444-555555555555";
    expect(
      resolveHomeDailyBriefJobId({
        appDir: tmpDir,
        jobIdFromFile: fromFile,
        jobExists: (id) => id === fromFile,
      }),
    ).toBe(fromFile);

    expect(
      resolveHomeDailyBriefJobId({
        appDir: tmpDir,
        jobExists: (id) => id === LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID,
      }),
    ).toBe(LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID);
  });

  it("resolveOrAllocateHomeDailyBriefJobId creates a new UUID for fresh workspaces", async () => {
    const appDir = path.join(tmpDir, "home-app");
    await fs.mkdir(appDir, { recursive: true });

    const jobId = await resolveOrAllocateHomeDailyBriefJobId({
      appDir,
      jobExists: () => false,
    });

    expect(jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(await fs.readFile(path.join(appDir, "default-job-id.txt"), "utf8")).toBe(
      `${jobId}\n`,
    );
  });

  it("shouldRewriteDailyBriefDbPath rewrites foreign namespace paths", async () => {
    const workspaceRoot = path.join(tmpDir, "orgs", "a", "namespaces", "ns-a");
    const foreignDb = path.join(
      tmpDir,
      "orgs",
      "b",
      "namespaces",
      "ns-b",
      "Jobs",
      "job-1",
      "data",
      "data.db",
    );
    const localDb = path.join(workspaceRoot, "Jobs", "job-1", "data", "data.db");
    await fs.mkdir(path.dirname(localDb), { recursive: true });
    await fs.writeFile(localDb, "", "utf8");

    expect(
      shouldRewriteDailyBriefDbPath({
        storedDbPath: foreignDb,
        resolvedDbPath: localDb,
        workspaceRoot,
      }),
    ).toBe(true);

    expect(
      shouldRewriteDailyBriefDbPath({
        storedDbPath: localDb,
        resolvedDbPath: localDb,
        workspaceRoot,
      }),
    ).toBe(false);
  });

  it("bundled Daily Brief default-job.json passes app-linked architecture validation", () => {
    const jobDefPath = path.join(
      process.cwd(),
      "src/resources/default-apps/home-dashboard/default-job.json",
    );
    const bundled = JSON.parse(readFileSync(jobDefPath, "utf8")) as {
      command?: string;
      appIds?: string[];
      type?: string;
    };
    const issues = validateJobArchitecture({
      type: bundled.type ?? "agent",
      command: bundled.command ?? "",
      appIds: bundled.appIds ?? [DEFAULT_HOME_APP_ID],
    });
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  /**
   * Regression: the bundled prompt used to instruct the agent to write the
   * briefs table with `sqlite3 "$APP_DB"`. That races the Turso replica sync
   * layer, so rows were silently discarded while the job still exited 0 —
   * the Home dashboard went stale for days with no error surfaced.
   */
  it("bundled Daily Brief prompt mandates save_brief.py and forbids direct sqlite3 writes", () => {
    const command = JSON.parse(
      readFileSync(
        path.join(
          process.cwd(),
          "src/resources/default-apps/home-dashboard/default-job.json",
        ),
        "utf8",
      ),
    ).command as string;

    expect(command).toContain('python3 "$JOB_DIR/save_brief.py"');
    // No instruction to write the DB directly, and no $APP_DB write target.
    expect(command).not.toMatch(/sqlite3\s+\\?"?\$APP_DB/);
    expect(command).not.toContain("$APP_DB");
    // Must warn that /api/db/* reports errors with HTTP 200.
    expect(command).toContain("HTTP 200");
  });

  /**
   * The briefs DB must live at data/databases/{slug}/data.db.
   * registrySlugFromLocalPath() only matches that shape, and register()
   * derives a j-* Turso instance from ownerJobId. Pointing at the job's
   * data/data.db yields a job DB with a replica flag — not a registry DB.
   */
  it("Home briefs slug resolves to a real registry database path", async () => {
    const { registrySlugFromLocalPath } = await import(
      "../src/gateway/services/DatabaseRegistryService.js"
    );

    const registryPath = `/Papr/data/databases/${DEFAULT_HOME_BRIEFS_DB_SLUG}/data.db`;
    expect(registrySlugFromLocalPath(registryPath)).toBe(
      DEFAULT_HOME_BRIEFS_DB_SLUG,
    );

    // The shape we must NOT use — a job DB is not a registry DB.
    expect(
      registrySlugFromLocalPath(
        "/Papr/Jobs/6953796f-b12d-4397-bc80-78bc43911fce/data/data.db",
      ),
    ).toBeNull();
  });

  it("bundled registry migration creates briefs with a primary key", () => {
    const sql = readFileSync(
      path.join(
        process.cwd(),
        "src/resources/default-apps/home-dashboard/db-migrations/0001_init.sql",
      ),
      "utf8",
    );
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS\s+briefs/i);
    // Turso replica sync requires a PRIMARY KEY for row versioning.
    expect(sql).toMatch(/date\s+TEXT\s+PRIMARY KEY/i);
  });

  it("bundled save_brief.py never hardcodes a sourceId and checks the error field", () => {
    const script = readFileSync(
      path.join(
        process.cwd(),
        "src/resources/default-apps/home-dashboard/job-assets/save_brief.py",
      ),
      "utf8",
    );

    // Resolves the source from data-sources.json rather than guessing.
    expect(script).toContain("def resolve_source_id");
    expect(script).not.toContain("Daily Brief Generator (");
    // The check that was missing and caused the silent no-op.
    expect(script).toContain('parsed.get("error")');
    // Verifies by reading the row back, not by trusting the write response.
    expect(script).toContain("write reported success but no row exists");
  });
});
