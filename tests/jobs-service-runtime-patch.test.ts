import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JobsService } from "../src/gateway/services/JobsService.js";
import { JOB_RUNTIME_FILE_NAME } from "../src/gateway/services/jobs/jobRuntimeFields.js";

describe("JobsService.applyCloudRunPatch", () => {
  let tmpRoot: string;
  let jobsService: JobsService;
  const prevFlag = process.env.JOB_RUNTIME_OFF_GIT;
  const prevHome = process.env.PAPR_HOME;
  const prevGatewayMode = process.env.GATEWAY_MODE;

  beforeEach(async () => {
    process.env.JOB_RUNTIME_OFF_GIT = "1";
    process.env.GATEWAY_MODE = "cloud_agent";
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "papr-jobs-runtime-"));
    process.env.PAPR_HOME = tmpRoot;

    const jobsRoot = path.join(tmpRoot, "Jobs");
    const dataDir = path.join(tmpRoot, "data");
    await mkdir(jobsRoot, { recursive: true });
    await mkdir(dataDir, { recursive: true });

    const jobId = "test-job-id";
    const jobDir = path.join(jobsRoot, jobId);
    await mkdir(jobDir, { recursive: true });

    const createdAt = "2025-01-01T00:00:00.000Z";
    await writeFile(
      path.join(jobDir, "job.json"),
      JSON.stringify(
        {
          id: jobId,
          name: "Patch Test",
          type: "bash",
          appIds: ["__standalone__"],
          command: "echo test",
          createdAt,
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      path.join(jobDir, JOB_RUNTIME_FILE_NAME),
      JSON.stringify(
        {
          status: "pending",
          updatedAt: createdAt,
          scheduleState: { nextRunAt: "2025-06-01T10:00:00.000Z" },
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      path.join(dataDir, "jobs.json"),
      JSON.stringify(
        [
          {
            id: jobId,
            name: "Patch Test",
            type: "bash",
            appIds: ["__standalone__"],
            command: "echo test",
            createdAt,
          },
        ],
        null,
        2,
      ),
      "utf8",
    );

    jobsService = new JobsService();
    await jobsService.initialize();
  });

  afterEach(async () => {
    if (prevFlag === undefined) {
      delete process.env.JOB_RUNTIME_OFF_GIT;
    } else {
      process.env.JOB_RUNTIME_OFF_GIT = prevFlag;
    }
    if (prevHome === undefined) {
      delete process.env.PAPR_HOME;
    } else {
      process.env.PAPR_HOME = prevHome;
    }
    if (prevGatewayMode === undefined) {
      delete process.env.GATEWAY_MODE;
    } else {
      process.env.GATEWAY_MODE = prevGatewayMode;
    }
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test("applies newer patch and advances scheduleState", async () => {
    const result = await jobsService.applyCloudRunPatch({
      jobId: "test-job-id",
      status: "completed",
      exitCode: 0,
      lastOutput: "done",
      scheduleState: { nextRunAt: "2025-06-01T11:00:00.000Z" },
      recordedAt: "2025-06-01T10:30:00.000Z",
      source: "cloud_scheduler",
    });

    expect(result?.status).toBe("completed");
    expect(result?.scheduleState?.nextRunAt).toBe("2025-06-01T11:00:00.000Z");

    const runtimeRaw = await readFile(
      path.join(tmpRoot, "Jobs", "test-job-id", JOB_RUNTIME_FILE_NAME),
      "utf8",
    );
    const runtime = JSON.parse(runtimeRaw) as { status: string };
    expect(runtime.status).toBe("completed");
  });

  test("skips stale patch via LWW", async () => {
    await jobsService.applyCloudRunPatch({
      jobId: "test-job-id",
      status: "completed",
      recordedAt: "2025-06-01T12:00:00.000Z",
      source: "cloud_scheduler",
    });

    const skipped = await jobsService.applyCloudRunPatch({
      jobId: "test-job-id",
      status: "failed",
      recordedAt: "2025-06-01T11:00:00.000Z",
      source: "cloud_scheduler",
    });

    expect(skipped).toBeNull();
    const job = await jobsService.getJob("test-job-id");
    expect(job?.status).toBe("completed");
  });

  test("reloadJobs hydrates runtime from job.runtime.json when flag on", async () => {
    await jobsService.applyCloudRunPatch({
      jobId: "test-job-id",
      status: "completed",
      exitCode: 0,
      recordedAt: "2025-06-01T12:00:00.000Z",
      scheduleState: { nextRunAt: "2025-06-01T13:00:00.000Z" },
      source: "cloud_scheduler",
    });

    await jobsService.reloadJobs();

    const job = await jobsService.getJob("test-job-id");
    expect(job?.status).toBe("completed");
    expect(job?.scheduleState?.nextRunAt).toBe("2025-06-01T13:00:00.000Z");
  });
});
