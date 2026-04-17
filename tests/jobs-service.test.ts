import os from "os";
import path from "path";
import { promises as fs } from "fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { JobsService } from "../src/gateway/services/JobsService.js";
import { getAgentService } from "../src/gateway/services/AgentService.js";

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

describe("JobsService index corruption recovery", () => {
  test("recovers job names from job.json when jobs.json is wiped", async () => {
    const service = await setupService();
    const job1 = await service.createJob({
      name: "LinkedIn Scraper",
      type: "python",
      command: "python3 scrape.py",
    });
    const job2 = await service.createJob({
      name: "Weekly Newsletter",
      type: "agent",
      command: "Write the weekly newsletter",
    });
    const job3 = await service.createJob({
      name: "Deploy Script",
      type: "shell",
      command: "echo deploy",
    });

    const jobsIndexPath = path.join(
      process.env.HOME!,
      "Papr",
      "data",
      "jobs.json",
    );

    // Verify job.json files exist on disk with real names
    for (const job of [job1, job2, job3]) {
      const jobJsonPath = path.join(
        process.env.HOME!,
        "Papr",
        "Jobs",
        job.id,
        "job.json",
      );
      const data = JSON.parse(await fs.readFile(jobJsonPath, "utf-8"));
      expect(data.name).toBe(job.name);
    }

    // Simulate corruption: wipe jobs.json to empty
    await fs.writeFile(jobsIndexPath, "", "utf-8");

    // Create a fresh service that will hit the corrupted index and recover
    const recovered = new JobsService();
    await recovered.initialize();
    const jobs = await recovered.listJobs();

    // All three user-created jobs should be recovered with real names
    const scraper = jobs.find((j) => j.name === "LinkedIn Scraper");
    expect(scraper).toBeDefined();
    expect(scraper?.type).toBe("python");

    const newsletter = jobs.find((j) => j.name === "Weekly Newsletter");
    expect(newsletter).toBeDefined();
    expect(newsletter?.type).toBe("agent");

    const deploy = jobs.find((j) => j.name === "Deploy Script");
    expect(deploy).toBeDefined();
    expect(deploy?.type).toBe("shell");

    // No job should have a UUID as its name (the bug we're preventing)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const job of jobs) {
      expect(
        uuidRegex.test(job.name),
        `Job "${job.id}" has UUID as name — recovery failed to read job.json`,
      ).toBe(false);
    }
  });

  test("recovers job names when jobs.json is deleted entirely", async () => {
    const service = await setupService();
    const created = await service.createJob({
      name: "Nightly Backup",
      type: "bash",
      command: "tar czf backup.tgz .",
    });

    const jobsIndexPath = path.join(
      process.env.HOME!,
      "Papr",
      "data",
      "jobs.json",
    );
    await fs.rm(jobsIndexPath);

    const recovered = new JobsService();
    await recovered.initialize();
    const jobs = await recovered.listJobs();

    const backup = jobs.find((j) => j.name === "Nightly Backup");
    expect(backup).toBeDefined();
    expect(backup?.type).toBe("bash");
    expect(backup?.command).toBe("tar czf backup.tgz .");
  });

  test("recovered job names are never raw UUIDs when job.json exists", async () => {
    const service = await setupService();
    const created = await service.createJob({
      name: "Data Pipeline",
      type: "python",
      command: "python3 pipeline.py",
    });

    // Simulate corruption: empty JSON array (no jobs)
    const jobsIndexPath = path.join(
      process.env.HOME!,
      "Papr",
      "data",
      "jobs.json",
    );
    await fs.writeFile(jobsIndexPath, "[]", "utf-8");

    const recovered = new JobsService();
    await recovered.initialize();
    const jobs = await recovered.listJobs();

    const pipeline = jobs.find((j) => j.id === created.id);
    expect(pipeline).toBeDefined();
    expect(pipeline?.name).not.toBe(created.id);
    expect(pipeline?.name).toBe("Data Pipeline");
  });
});
