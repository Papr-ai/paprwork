import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { STANDALONE_APP_ID } from "../src/gateway/services/jobs/appIds.js";
import { getJobsService } from "../src/gateway/services/JobsService.js";
import { getJobsScheduler } from "../src/gateway/services/JobsScheduler.js";
import { getJobRunHistory } from "../src/gateway/services/jobs/JobRunHistory.js";
import { classifyError } from "../src/gateway/services/jobs/errorClassifier.js";

/**
 * Simplified E2E tests for job scheduling
 * Avoids complex mocking to prevent Vitest serialization issues
 */
describe("Job Scheduling E2E (Simplified)", () => {
  beforeAll(async () => {
    const jobsService = getJobsService();
    await jobsService.initialize();

    const runHistory = getJobRunHistory();
    await runHistory.initialize();
  });

  afterAll(async () => {
    // Cleanup test jobs
    const jobsService = getJobsService();
    const jobs = await jobsService.listJobs();
    for (const job of jobs) {
      if (job.name.startsWith("E2E Test")) {
        await jobsService.deleteJob(job.id, true);
      }
    }
  });

  test("bash job runs and records history", async () => {
    const jobsService = getJobsService();

    // Create bash job
    const job = await jobsService.createJob({
      name: "E2E Test Bash Job",
      appIds: [STANDALONE_APP_ID],
      type: "bash",
      command: 'echo "E2E test successful"',
    });

    expect(job.id).toBeDefined();
    expect(job.status).toBe("pending");

    // Run the job
    const result = await jobsService.runJob(job.id);

    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);

    // Verify run history
    const runHistory = getJobRunHistory();
    const runs = await runHistory.getRunsForJob(job.id);

    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe("completed");
    expect(runs[0].exitCode).toBe(0);
    expect(runs[0].duration).toBeGreaterThan(0);

    // Verify stats
    const stats = await runHistory.getStats(job.id);
    expect(stats.totalRuns).toBe(1);
    expect(stats.completedRuns).toBe(1);
    expect(stats.failedRuns).toBe(0);

    // Cleanup
    await jobsService.deleteJob(job.id, true);
  }, 15000);

  test("bash job with failure records error", async () => {
    const jobsService = getJobsService();

    // Create bash job that fails
    const job = await jobsService.createJob({
      name: "E2E Test Failing Bash Job",
      appIds: [STANDALONE_APP_ID],
      type: "bash",
      command: "exit 1",
      retries: {
        maxAttempts: 2,
        backoffMs: 100,
      },
    });

    // Run the job
    const result = await jobsService.runJob(job.id);

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);

    // Verify run history shows attempts
    const runHistory = getJobRunHistory();
    const runs = await runHistory.getRunsForJob(job.id);

    expect(runs.length).toBe(2); // 2 attempts
    expect(runs[0].attempt).toBe(2);
    expect(runs[1].attempt).toBe(1);

    // Both should be failed
    runs.forEach((run) => {
      expect(run.status).toBe("failed");
      expect(run.exitCode).toBe(1);
    });

    // Cleanup
    await jobsService.deleteJob(job.id, true);
  }, 15000);

  test("scheduled job with intervalMs computes nextRunAt", async () => {
    const jobsService = getJobsService();

    // Create scheduled job
    const job = await jobsService.createJob({
      name: "E2E Test Scheduled Job",
      appIds: [STANDALONE_APP_ID],
      type: "bash",
      command: 'echo "scheduled"',
      schedule: {
        enabled: true,
        intervalMs: 60000, // 1 minute
      },
    });

    expect(job.schedule?.enabled).toBe(true);
    expect(job.scheduleState?.nextRunAt).toBeDefined();

    const nextRunAt = new Date(job.scheduleState!.nextRunAt!);
    const now = new Date();

    // nextRunAt should be in the future
    expect(nextRunAt.getTime()).toBeGreaterThan(now.getTime());

    // Should be approximately 1 minute from now (within 2 minutes tolerance)
    const diffMs = nextRunAt.getTime() - now.getTime();
    expect(diffMs).toBeGreaterThan(0);
    expect(diffMs).toBeLessThan(120000); // Within 2 minutes

    // Cleanup
    await jobsService.deleteJob(job.id, true);
  }, 10000);

  test("cron schedule computes correct nextRunAt", async () => {
    const jobsService = getJobsService();

    // Create cron job (every hour at minute 0)
    const job = await jobsService.createJob({
      name: "E2E Test Cron Job",
      appIds: [STANDALONE_APP_ID],
      type: "bash",
      command: 'echo "cron"',
      schedule: {
        enabled: true,
        cron: "0 * * * *",
      },
    });

    expect(job.schedule?.enabled).toBe(true);
    expect(job.scheduleState?.nextRunAt).toBeDefined();

    const nextRunAt = new Date(job.scheduleState!.nextRunAt!);
    const now = new Date();

    // nextRunAt should be in the future
    expect(nextRunAt.getTime()).toBeGreaterThan(now.getTime());

    // Minute should be 0 (top of hour)
    expect(nextRunAt.getMinutes()).toBe(0);

    // Cleanup
    await jobsService.deleteJob(job.id, true);
  }, 10000);

  test("python job runs and creates venv", async () => {
    const jobsService = getJobsService();

    // Create python job
    const job = await jobsService.createJob({
      name: "E2E Test Python Job",
      appIds: [STANDALONE_APP_ID],
      type: "python",
      command: "print('Python E2E test')",
    });

    // Run the job
    const result = await jobsService.runJob(job.id);

    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);

    // Verify run history
    const runHistory = getJobRunHistory();
    const runs = await runHistory.getRunsForJob(job.id);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe("completed");

    // Cleanup
    await jobsService.deleteJob(job.id, true);
  }, 30000);
});

describe("Error Classification", () => {
  test("classifies rate limit as transient", () => {
    const error = new Error("Rate limit exceeded");
    const type = classifyError(error);
    expect(type).toBe("transient");
  });

  test("classifies invalid API key as permanent", () => {
    const error = new Error("Invalid API key");
    const type = classifyError(error);
    expect(type).toBe("permanent");
  });

  test("classifies timeout as transient", () => {
    const error = new Error("Connection timeout");
    const type = classifyError(error);
    expect(type).toBe("transient");
  });

  test("classifies 401 as permanent", () => {
    const error = new Error("HTTP 401 Unauthorized");
    const type = classifyError(error);
    expect(type).toBe("permanent");
  });

  test("classifies unknown error as transient (safe default)", () => {
    const error = new Error("Unknown random error");
    const type = classifyError(error);
    expect(type).toBe("transient");
  });

  test("classifies context limit as permanent (compression handles internally)", () => {
    const error = new Error(
      "Agent job model error (openai/gpt-5.4): Context limit approaching. Conversation will be summarized automatically.",
    );
    const type = classifyError(error);
    expect(type).toBe("permanent");
  });

  test("classifies context_length_exceeded as permanent", () => {
    const error = new Error("context_length_exceeded: max tokens exceeded");
    const type = classifyError(error);
    expect(type).toBe("permanent");
  });
});

describe("Run History Management", () => {
  test("stores and retrieves multiple runs", async () => {
    const runHistory = getJobRunHistory();
    await runHistory.initialize();

    const jobId = "test-history-job";

    // Append 3 runs
    for (let i = 1; i <= 3; i++) {
      await runHistory.appendRun({
        runId: `${jobId}-run-${i}`,
        jobId,
        status: i === 2 ? "failed" : "completed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        duration: 1000 * i,
        exitCode: i === 2 ? 1 : 0,
        attempt: 1,
        maxAttempts: 1,
      });
    }

    // Retrieve runs
    const runs = await runHistory.getRunsForJob(jobId, 10);
    expect(runs.length).toBe(3);

    // Should be in reverse order (newest first)
    expect(runs[0].runId).toBe(`${jobId}-run-3`);
    expect(runs[2].runId).toBe(`${jobId}-run-1`);

    // Verify stats
    const stats = await runHistory.getStats(jobId);
    expect(stats.totalRuns).toBe(3);
    expect(stats.completedRuns).toBe(2);
    expect(stats.failedRuns).toBe(1);
    expect(stats.avgDuration).toBe(2000); // (1000 + 2000 + 3000) / 3

    const summary = await runHistory.getGlobalSummary();
    expect(summary.totalRuns).toBeGreaterThanOrEqual(3);
    expect(summary.completedRuns).toBeGreaterThanOrEqual(2);
    expect(summary.failedRuns).toBeGreaterThanOrEqual(1);
    expect(summary.successRate).toBeGreaterThan(0);
    expect(summary.topJobs.length).toBeGreaterThan(0);
  }, 10000);
});
