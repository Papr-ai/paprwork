import os from "os";
import path from "path";
import { promises as fs } from "fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { JobsService } from "../src/gateway/services/JobsService.js";
import { STANDALONE_APP_ID } from "../src/gateway/services/jobs/appIds.js";
import { getAgentService } from "../src/gateway/services/AgentService.js";
import {
  getAppService,
  resetAppServiceSingletonForTests,
} from "../src/gateway/services/AppService.js";
import { resetJobsServiceSingletonForTests } from "../src/gateway/services/JobsService.js";
import { bumpWorkspaceWriteGeneration } from "../src/gateway/services/workspaceWriteGuard.js";
import { WORKSPACE_CHAT_JOB_ID } from "../src/core/constants/workspaceChatJob.js";

function userVisibleJobs(jobs: Awaited<ReturnType<JobsService["listJobs"]>>) {
  return jobs.filter((job) => job.id !== WORKSPACE_CHAT_JOB_ID);
}

const tmpRoots: string[] = [];

afterEach(async () => {
  // Brief delay to let file watchers release handles before cleanup
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const root of tmpRoots.splice(0, tmpRoots.length)) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

async function setupService(): Promise<JobsService> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "papr-jobs-test-"));
  tmpRoots.push(root);
  process.env.HOME = root;
  // HOME alone is not enough: getPaprRoot() prefers ~/Papr/.active-workspace.json
  // (read from the REAL home) and re-syncs PAPR_HOME from it. Without this the
  // suite created hundreds of job folders in the developer's live workspace.
  process.env.PAPR_HOME = path.join(root, "Papr");
  await fs.mkdir(process.env.PAPR_HOME, { recursive: true });
  resetAppServiceSingletonForTests();
  resetJobsServiceSingletonForTests();
  const service = new JobsService();
  await service.initialize();
  await service.waitForStartupMaintenance();
  return service;
}

describe("JobsService", () => {
  test("creates and lists jobs", async () => {
    const service = await setupService();
    await service.createJob({ name: "Build docs", appIds: [STANDALONE_APP_ID], type: "shell", command: "echo hi" });
    const jobs = userVisibleJobs(await service.listJobs());
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("Build docs");
  });

  test("runs a shell job and captures completion", async () => {
    const service = await setupService();
    const job = await service.createJob({
      name: "Simple job",
      appIds: [STANDALONE_APP_ID], type: "shell",
      command: "echo hello",
    });
    await service.runJob(job.id);

    // Wait briefly for process completion callback.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const refreshed = await service.getJob(job.id);
    expect(refreshed?.status).toBe("completed");
    const logs = await service.getLogs(job.id);
    expect(logs).toContain("hello");
  });

  test("bootstraps per-job sqlite database on creation", async () => {
    const service = await setupService();
    const job = await service.createJob({
      name: "DB Job",
      appIds: [STANDALONE_APP_ID], type: "python",
    });
    const dbPath = await service.getJobDatabasePath(job.id);
    expect(dbPath).toBeTruthy();
    const dbStat = await fs.stat(dbPath as string);
    expect(dbStat.isFile()).toBe(true);
  });

  test("createJob does not auto-link scratch database (use attach_database)", async () => {
    const service = await setupService();
    const appService = getAppService();
    await appService.initialize();
    const app = await appService.createApp("Sync Dashboard", "Desc", [
      { filename: "index.html", content: "<div>Dashboard</div>" },
    ]);

    await service.createJob({
      name: "Data Sync",
      appIds: [app.id],
      type: "python",
      command: "print('sync')",
    });

    const sources = await appService.listAppDataSources(app.id);
    expect(sources).toHaveLength(0);
  });

  test("runs agent jobs via executor immediate path", async () => {
    const service = await setupService();
    const agentService = getAgentService();
    const runSpy = vi
      .spyOn(agentService, "runIsolatedJobSession")
      .mockResolvedValue({
        chatId: "job:test",
        text: "Mocked agent result",
      });
    const job = await service.createJob({
      name: "Agent Job",
      appIds: [STANDALONE_APP_ID], type: "agent",
    });
    await service.runJob(job.id);
    const refreshed = await service.getJob(job.id);
    expect(refreshed?.status).toBe("completed");
    const logs = await service.getLogs(job.id);
    expect(logs).toContain("Mocked agent result");
    runSpy.mockRestore();
  });

  test("retries failed command jobs with backoff policy", async () => {
    const service = await setupService();
    const job = await service.createJob({
      name: "Retry Job",
      appIds: [STANDALONE_APP_ID], type: "shell",
      command:
        "if [ ! -f ./data/first_try.flag ]; then touch ./data/first_try.flag; echo first-fail; exit 1; fi; echo recovered",
      retries: { maxAttempts: 2, backoffMs: 5 },
    });
    await service.runJob(job.id);
    const refreshed = await service.getJob(job.id);
    expect(refreshed?.status).toBe("completed");
    const logs = await service.getLogs(job.id);
    expect(logs).toContain("first-fail");
    expect(logs).toContain("(in 5ms)");
    expect(logs).toContain("recovered");
  });

  test("runs dependency chain before dependent job", async () => {
    const service = await setupService();
    const baseJob = await service.createJob({
      name: "Base Job",
      appIds: [STANDALONE_APP_ID], type: "shell",
      command: "echo base-done",
    });
    const dependentJob = await service.createJob({
      name: "Dependent Job",
      appIds: [STANDALONE_APP_ID], type: "shell",
      command: "echo dependent-done",
      dependsOn: [{ jobId: baseJob.id, onStatus: "completed" }],
    });

    await service.runJob(dependentJob.id);
    const refreshedBase = await service.getJob(baseJob.id);
    const refreshedDependent = await service.getJob(dependentJob.id);
    expect(refreshedBase?.status).toBe("completed");
    expect(refreshedDependent?.status).toBe("completed");
  });

  test("applies SQL migrations before job execution", async () => {
    const service = await setupService();
    const job = await service.createJob({
      name: "Migration Job",
      appIds: [STANDALONE_APP_ID], type: "shell",
      command: "echo migration-run",
    });
    const jobPath = await service.getJobPath(job.id);
    expect(jobPath).toBeTruthy();
    await fs.writeFile(
      path.join(jobPath as string, "migrations", "0002_test.sql"),
      "CREATE TABLE IF NOT EXISTS migration_test (id INTEGER PRIMARY KEY);",
      "utf8",
    );

    await service.runJob(job.id);
    const logs = await service.getLogs(job.id);
    expect(logs).toContain("0002_test.sql");
  });
});

describe("JobsService lifecycle helpers", () => {
  test("listActiveJobs and stopAllJobs cancel jobs without tracked child processes", async () => {
    const service = await setupService();
    const job = await service.createJob({
      name: "Long agent job",
      appIds: [STANDALONE_APP_ID],
      type: "agent",
      command: "Analyze data",
    });
    await service.upsertJob({
      ...job,
      status: "running",
      updatedAt: new Date().toISOString(),
    });

    expect(service.listActiveJobs()).toEqual([
      {
        id: job.id,
        name: "Long agent job",
        type: "agent",
        status: "running",
      },
    ]);

    const result = await service.stopAllJobs("stopped for test");
    expect(result.stoppedCount).toBe(1);

    const refreshed = await service.getJob(job.id);
    expect(refreshed?.status).toBe("cancelled");
    expect(refreshed?.error).toBe("stopped for test");
  });

  test("saveJobs skips disk writes after workspace write generation bump", async () => {
    const service = await setupService();
    const job = await service.createJob({
      name: "Guarded job",
      appIds: [STANDALONE_APP_ID],
      type: "shell",
      command: "echo hi",
    });
    const indexPath = path.join(process.env.PAPR_HOME!, "data", "jobs.json");
    const before = await fs.readFile(indexPath, "utf8");

    bumpWorkspaceWriteGeneration("test switch");
    await service.upsertJob({
      ...job,
      status: "running",
      updatedAt: new Date().toISOString(),
    });

    const after = await fs.readFile(indexPath, "utf8");
    expect(after).toBe(before);
  });

  test("listJobs does not scan job folders on disk (hot path stays in-memory)", async () => {
    const service = await setupService();
    for (let i = 0; i < 5; i += 1) {
      await service.createJob({
        name: `Job ${i}`,
        appIds: [STANDALONE_APP_ID],
        type: "shell",
        command: "echo hi",
      });
    }

    const statSpy = vi.spyOn(fs, "stat");
    const readdirSpy = vi.spyOn(fs, "readdir");
    statSpy.mockClear();
    readdirSpy.mockClear();

    await service.listJobs();
    await service.listJobs();

    expect(statSpy).not.toHaveBeenCalled();
    expect(readdirSpy).not.toHaveBeenCalled();

    statSpy.mockRestore();
    readdirSpy.mockRestore();
  });
});
