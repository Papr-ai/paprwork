import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "fs";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import {
  DEFAULT_HOME_APP_ID,
  DEFAULT_HOME_DAILY_BRIEF_JOB_NAME,
  LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID,
} from "../src/gateway/services/defaultHomeBundle.js";
import {
  LEGACY_HOME_JOB_MIGRATION_MARKER,
  migrateLegacyHomeDailyBriefJobIfNeeded,
} from "../src/gateway/services/migrateLegacyHomeDailyBriefJob.js";
import type { JobRecord } from "../src/gateway/services/jobs/types.js";
import { loadTursoSyncState } from "../src/gateway/services/tursoSyncState.js";
import { loadConvergenceState } from "../src/gateway/services/cloudSync/convergenceChecker.js";

describe("migrateLegacyHomeDailyBriefJob", () => {
  let tmpDir: string;
  let appsDir: string;
  let jobsRoot: string;
  let jobs: Map<string, JobRecord>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-home-migrate-"));
    appsDir = path.join(tmpDir, "apps");
    jobsRoot = path.join(tmpDir, "Jobs");
    await fs.mkdir(path.join(tmpDir, "data"), { recursive: true });
    await fs.mkdir(path.join(appsDir, DEFAULT_HOME_APP_ID), { recursive: true });
    jobs = new Map();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function seedLegacyJob(): Promise<string> {
    const legacyDir = path.join(jobsRoot, LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID);
    await fs.mkdir(path.join(legacyDir, "data"), { recursive: true });
    await fs.mkdir(path.join(legacyDir, "code"), { recursive: true });
    const dbPath = path.join(legacyDir, "data", "data.db");
    await fs.writeFile(dbPath, "legacy-brief-db-marker", "utf8");
    await fs.writeFile(
      path.join(legacyDir, "code", "marker.txt"),
      "legacy-job-folder",
      "utf8",
    );

    const job: JobRecord = {
      id: LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID,
      name: DEFAULT_HOME_DAILY_BRIEF_JOB_NAME,
      type: "agent",
      status: "idle",
      appIds: [DEFAULT_HOME_APP_ID],
      dependsOn: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    jobs.set(job.id, job);
    await fs.writeFile(
      path.join(legacyDir, "job.json"),
      JSON.stringify(job, null, 2),
      "utf8",
    );

    await fs.writeFile(
      path.join(appsDir, DEFAULT_HOME_APP_ID, "data-sources.json"),
      JSON.stringify(
        {
          sources: [
            {
              id: `${LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID}:Daily Brief Generator (2cafb2e9)`,
              type: "sqlite",
              jobId: LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID,
              alias: "Daily Brief Generator (2cafb2e9)",
              dbPath: "",
              tables: ["briefs"],
              linkedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    return dbPath;
  }

  it("migrates legacy job to a namespace-owned UUID and rewrites references", async () => {
    await seedLegacyJob();

    await fs.writeFile(
      path.join(tmpDir, "data", ".turso-sync-state.json"),
      JSON.stringify(
        {
          jobs: {
            [LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID]: {
              dbPath: path.join(
                jobsRoot,
                LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID,
                "data",
                "data.db",
              ),
              lastPushAt: "2026-08-17T00:00:00.000Z",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "data", ".turso-convergence-state.json"),
      JSON.stringify(
        {
          sources: {
            [LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID]: {
              syncKey: LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID,
              appId: DEFAULT_HOME_APP_ID,
              alias: "Daily Brief",
              lastCheckedAt: null,
              lastVerifiedAt: null,
              ok: false,
              driftTables: ["briefs"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    let savedJobs: JobRecord[] = [];
    const result = await migrateLegacyHomeDailyBriefJobIfNeeded({
      paprDir: tmpDir,
      appsDir,
      jobsRoot,
      jobs,
      saveJobs: async () => {
        savedJobs = [...jobs.values()];
        await fs.writeFile(
          path.join(tmpDir, "data", "jobs.json"),
          JSON.stringify(savedJobs, null, 2),
          "utf8",
        );
      },
      persistJobRecord: async (job) => {
        const jobDir = path.join(jobsRoot, job.id);
        await fs.mkdir(jobDir, { recursive: true });
        await fs.writeFile(
          path.join(jobDir, "job.json"),
          JSON.stringify(job, null, 2),
          "utf8",
        );
      },
    });

    expect(result.migrated).toBe(true);
    expect(result.fromJobId).toBe(LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID);
    expect(result.toJobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(result.toJobId).not.toBe(LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID);

    expect(jobs.has(LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID)).toBe(false);
    expect(jobs.has(result.toJobId!)).toBe(true);

    const newDbPath = path.join(jobsRoot, result.toJobId!, "data", "data.db");
    expect(existsSync(newDbPath)).toBe(true);
    expect(await fs.readFile(newDbPath, "utf8")).toBe("legacy-brief-db-marker");
    expect(
      await fs.readFile(
        path.join(jobsRoot, result.toJobId!, "code", "marker.txt"),
        "utf8",
      ),
    ).toBe("legacy-job-folder");

    expect(
      existsSync(path.join(jobsRoot, LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID)),
    ).toBe(false);
    expect(
      existsSync(
        path.join(jobsRoot, `${LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID}.migrated`),
      ),
    ).toBe(true);

    const jobIdFile = await fs.readFile(
      path.join(appsDir, DEFAULT_HOME_APP_ID, "default-job-id.txt"),
      "utf8",
    );
    expect(jobIdFile.trim()).toBe(result.toJobId);

    const dataSources = JSON.parse(
      await fs.readFile(
        path.join(appsDir, DEFAULT_HOME_APP_ID, "data-sources.json"),
        "utf8",
      ),
    ) as { sources: Array<{ jobId?: string; dbPath?: string }> };
    expect(dataSources.sources[0]?.jobId).toBe(result.toJobId);
    expect(dataSources.sources[0]?.dbPath).toBe(newDbPath);

    const tursoState = loadTursoSyncState(tmpDir);
    expect(tursoState.jobs[result.toJobId!]?.dbPath).toBe(newDbPath);
    expect(tursoState.jobs[LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID]).toBeUndefined();

    const convergence = loadConvergenceState(tmpDir);
    expect(convergence.sources[result.toJobId!]?.syncKey).toBe(result.toJobId);
    expect(
      convergence.sources[LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID],
    ).toBeUndefined();

    const marker = JSON.parse(
      await fs.readFile(
        path.join(tmpDir, "data", LEGACY_HOME_JOB_MIGRATION_MARKER),
        "utf8",
      ),
    ) as { fromJobId: string; toJobId: string };
    expect(marker.fromJobId).toBe(LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID);
    expect(marker.toJobId).toBe(result.toJobId);
  });

  it("is idempotent after migration marker is written", async () => {
    await seedLegacyJob();
    const deps = {
      paprDir: tmpDir,
      appsDir,
      jobsRoot,
      jobs,
      saveJobs: async () => {},
      persistJobRecord: async (job: JobRecord) => {
        await fs.mkdir(path.join(jobsRoot, job.id), { recursive: true });
        await fs.writeFile(
          path.join(jobsRoot, job.id, "job.json"),
          JSON.stringify(job, null, 2),
          "utf8",
        );
      },
    };

    const first = await migrateLegacyHomeDailyBriefJobIfNeeded(deps);
    expect(first.migrated).toBe(true);

    const second = await migrateLegacyHomeDailyBriefJobIfNeeded(deps);
    expect(second.migrated).toBe(false);
    expect(second.reason).toBe("already_migrated");
  });

  it("skips when namespace job id is already assigned", async () => {
    const namespaceJobId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    jobs.set(namespaceJobId, {
      id: namespaceJobId,
      name: DEFAULT_HOME_DAILY_BRIEF_JOB_NAME,
      type: "agent",
      status: "pending",
      appIds: [DEFAULT_HOME_APP_ID],
      dependsOn: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await fs.writeFile(
      path.join(appsDir, DEFAULT_HOME_APP_ID, "default-job-id.txt"),
      `${namespaceJobId}\n`,
      "utf8",
    );

    const result = await migrateLegacyHomeDailyBriefJobIfNeeded({
      paprDir: tmpDir,
      appsDir,
      jobsRoot,
      jobs,
      saveJobs: async () => {},
      persistJobRecord: async () => {},
    });

    expect(result.migrated).toBe(false);
    expect(result.reason).toBe("namespace_job_already_assigned");
  });

  it("uses pre-assigned default-job-id.txt when job folder is not registered yet", async () => {
    const namespaceJobId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await seedLegacyJob();
    await fs.writeFile(
      path.join(appsDir, DEFAULT_HOME_APP_ID, "default-job-id.txt"),
      `${namespaceJobId}\n`,
      "utf8",
    );

    const result = await migrateLegacyHomeDailyBriefJobIfNeeded({
      paprDir: tmpDir,
      appsDir,
      jobsRoot,
      jobs,
      saveJobs: async () => {},
      persistJobRecord: async (job: JobRecord) => {
        await fs.mkdir(path.join(jobsRoot, job.id), { recursive: true });
        await fs.writeFile(
          path.join(jobsRoot, job.id, "job.json"),
          JSON.stringify(job, null, 2),
          "utf8",
        );
      },
    });

    expect(result.migrated).toBe(true);
    expect(result.toJobId).toBe(namespaceJobId);
    expect(jobs.has(namespaceJobId)).toBe(true);
  });
});
