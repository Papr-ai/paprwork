import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildDailyBriefDataSource,
  DEFAULT_HOME_APP_ID,
  DEFAULT_HOME_DAILY_BRIEF_JOB_NAME,
  findHomeDailyBriefJobIdInRegistry,
  LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID,
  resolveHomeDailyBriefJobId,
  resolveOrAllocateHomeDailyBriefJobId,
  shouldRewriteDailyBriefDbPath,
} from "../src/gateway/services/defaultHomeBundle.js";
import type { JobRecord } from "../src/gateway/services/jobs/types.js";

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
});
