import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildDailyBriefDataSource,
  dailyBriefDataSourceNeedsUpdate,
  DEFAULT_HOME_APP_ID,
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

  it("buildDailyBriefDataSource uses workspace-local source id", () => {
    const jobId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const source = buildDailyBriefDataSource(jobId, "/tmp/data.db");
    expect(source.id).toBe(`${jobId}:Daily Brief Generator (aaaaaaaa)`);
    expect(source.jobId).toBe(jobId);
    expect(source.tables).toEqual(["briefs"]);
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
    expect(merged.alias).toBe("Daily Brief Generator (6953796f)");
  });

  it("mergeDailyBriefDataSource replaces alias when job id changes", () => {
    const oldJobId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const newJobId = "6953796f-1111-2222-3333-444444444444";
    const existing = buildDailyBriefDataSource(oldJobId, "/old/data.db");
    existing.alias = "briefs";
    const merged = mergeDailyBriefDataSource(existing, newJobId, "/new/data.db");
    expect(merged.alias).toBe("Daily Brief Generator (6953796f)");
    expect(merged.jobId).toBe(newJobId);
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
});
