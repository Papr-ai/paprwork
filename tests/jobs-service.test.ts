import os from "os";
import path from "path";
import { promises as fs } from "fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { JobsService } from "../src/gateway/services/JobsService.js";
import { getAgentService } from "../src/gateway/services/AgentService.js";

const tmpRoots: string[] = [];

afterEach(async () => {
  for (const root of tmpRoots.splice(0, tmpRoots.length)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function setupService(): Promise<JobsService> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "papr-jobs-test-"));
  tmpRoots.push(root);
  process.env.HOME = root;
  const service = new JobsService();
  await service.initialize();
  return service;
}

describe("JobsService", () => {
  test("creates and lists jobs", async () => {
    const service = await setupService();
    await service.createJob({ name: "Build docs", type: "shell", command: "echo hi" });
    const jobs = await service.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("Build docs");
  });

  test("runs a shell job and captures completion", async () => {
    const service = await setupService();
    const job = await service.createJob({
      name: "Simple job",
      type: "shell",
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
      type: "python",
    });
    const dbPath = await service.getJobDatabasePath(job.id);
    expect(dbPath).toBeTruthy();
    const dbStat = await fs.stat(dbPath as string);
    expect(dbStat.isFile()).toBe(true);
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
      type: "agent",
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
      type: "shell",
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
      type: "shell",
      command: "echo base-done",
    });
    const dependentJob = await service.createJob({
      name: "Dependent Job",
      type: "shell",
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
      type: "shell",
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
