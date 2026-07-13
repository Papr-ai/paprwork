/**
 * E2E Job Scheduling Test
 *
 * Tests real job scheduling end-to-end:
 * - Create job with cron schedule
 * - Manually set nextRunAt to trigger immediately
 * - Verify job actually runs
 * - Check logs, run records, and nextRunAt advancement
 * - Verify idempotency (no duplicate runs)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rm, mkdir } from "node:fs/promises";
import path from "path";
import os from "os";
import {
  getJobsService,
  type JobRecord,
} from "../../src/gateway/services/JobsService.js";
import { STANDALONE_APP_ID } from "../../src/gateway/services/jobs/appIds.js";
import { JobsScheduler } from "../../src/gateway/services/JobsScheduler.js";

describe("E2E: Job Scheduling", () => {
  const testDir = path.join(os.tmpdir(), "paprwork-e2e-jobs-test");
  const testPaprRoot = path.join(testDir, "Papr");
  const testJobsRoot = path.join(testPaprRoot, "jobs");

  let originalHome: string;
  let jobsService: ReturnType<typeof getJobsService>;
  let scheduler: JobsScheduler;

  beforeAll(async () => {
    // Clean test directory
    await rm(testDir, { recursive: true, force: true });
    await mkdir(testDir, { recursive: true });

    // Override homedir to use test directory
    originalHome = os.homedir();
    Object.defineProperty(os, "homedir", {
      value: () => testDir,
      configurable: true,
    });

    // Initialize services with test directory
    jobsService = getJobsService();
    await jobsService.initialize();

    scheduler = new JobsScheduler();
  }, 30000);

  afterAll(async () => {
    // Stop scheduler
    scheduler.stop();

    // Restore original homedir
    Object.defineProperty(os, "homedir", {
      value: () => originalHome,
      configurable: true,
    });

    // Clean up test directory
    await rm(testDir, { recursive: true, force: true });
  });

  describe("Cron Job Execution", () => {
    let jobId: string;

    it("should create job with cron schedule", async () => {
      const job = await jobsService.createJob({
        name: "Test Cron Job",
        appIds: [STANDALONE_APP_ID],
        type: "shell",
        command: 'echo "Scheduled run at $(date)"',
        schedule: {
          enabled: true,
          cron: "* * * * *", // Every minute
        },
      });

      expect(job).toBeDefined();
      expect(job.id).toBeDefined();
      expect(job.schedule?.enabled).toBe(true);
      expect(job.schedule?.cron).toBe("* * * * *");
      expect(job.scheduleState?.nextRunAt).toBeDefined();

      jobId = job.id;
    });

    it("should have nextRunAt in the future initially", async () => {
      const job = await jobsService.getJob(jobId);
      expect(job?.scheduleState?.nextRunAt).toBeDefined();

      const nextRunAt = new Date(job!.scheduleState!.nextRunAt!);
      const now = new Date();

      expect(nextRunAt.getTime()).toBeGreaterThan(now.getTime());
    });

    it("should trigger job when nextRunAt is set to past", async () => {
      // Manually set nextRunAt to 5 seconds in the past to trigger immediately
      const pastTime = new Date(Date.now() - 5000).toISOString();
      const job = await jobsService.getJob(jobId);

      await jobsService.upsertJob({
        ...job!,
        scheduleState: {
          ...job!.scheduleState,
          nextRunAt: pastTime,
        },
      });

      // Run scheduler tick
      await scheduler.tickNow();

      // Wait for job to complete
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Check job status
      const updatedJob = await jobsService.getJob(jobId);
      expect(updatedJob?.status).toBe("completed");
      expect(updatedJob?.exitCode).toBe(0);
    }, 10000);

    it("should have execution logs", async () => {
      const logs = await jobsService.getLogs(jobId);

      expect(logs).toBeDefined();
      expect(typeof logs).toBe("string");
      expect(logs.length).toBeGreaterThan(0);

      // Should contain the echo output
      const hasScheduledRun = logs.includes("Scheduled run at");
      expect(hasScheduledRun).toBe(true);
    });

    it("should have run record and logs", async () => {
      const job = await jobsService.getJob(jobId);

      expect(job).toBeDefined();
      expect(job?.lastRunAt).toBeDefined();
      expect(job?.completedAt).toBeDefined();
      expect(job?.exitCode).toBe(0);

      // Verify logs exist and contain output
      const logs = await jobsService.getLogs(jobId);
      expect(logs).toBeDefined();
      expect(typeof logs).toBe("string");
      expect(logs.length).toBeGreaterThan(0);
    });

    it("should advance nextRunAt to next cron slot", async () => {
      const job = await jobsService.getJob(jobId);

      expect(job?.scheduleState?.nextRunAt).toBeDefined();
      expect(job?.scheduleState?.lastTriggeredAt).toBeDefined();

      const nextRunAt = new Date(job!.scheduleState!.nextRunAt!);
      const lastTriggeredAt = new Date(job!.scheduleState!.lastTriggeredAt!);

      // nextRunAt should be after lastTriggeredAt
      expect(nextRunAt.getTime()).toBeGreaterThan(lastTriggeredAt.getTime());

      // nextRunAt should be in the future
      const now = new Date();
      expect(nextRunAt.getTime()).toBeGreaterThan(now.getTime());
    });

    it("should not re-run job with same nextRunAt (idempotency)", async () => {
      const beforeJob = await jobsService.getJob(jobId);
      const lastRunAtBefore = beforeJob?.lastRunAt;
      const completedAtBefore = beforeJob?.completedAt;

      // Run scheduler tick again (nextRunAt is now in future)
      await scheduler.tickNow();

      // Wait briefly
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Job should not have run again
      const afterJob = await jobsService.getJob(jobId);
      expect(afterJob?.lastRunAt).toBe(lastRunAtBefore);
      expect(afterJob?.completedAt).toBe(completedAtBefore);
      expect(afterJob?.status).toBe("completed");
    });

    it("should run again when nextRunAt is set to past second time", async () => {
      const beforeJob = await jobsService.getJob(jobId);
      const lastRunAtBefore = beforeJob?.lastRunAt;

      // Set nextRunAt to past again
      const pastTime = new Date(Date.now() - 3000).toISOString();
      await jobsService.upsertJob({
        ...beforeJob!,
        scheduleState: {
          ...beforeJob!.scheduleState,
          nextRunAt: pastTime,
        },
      });

      // Run scheduler tick
      await scheduler.tickNow();

      // Wait for job to complete
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Check job ran again
      const afterJob = await jobsService.getJob(jobId);
      expect(afterJob?.lastRunAt).toBeDefined();
      expect(afterJob?.lastRunAt).not.toBe(lastRunAtBefore);
      expect(afterJob?.status).toBe("completed");
    }, 10000);
  });

  describe("Interval Job Execution", () => {
    let intervalJobId: string;

    it("should create job with interval schedule", async () => {
      const job = await jobsService.createJob({
        name: "Test Interval Job",
        appIds: [STANDALONE_APP_ID],
        type: "shell",
        command: 'echo "Interval run"',
        schedule: {
          enabled: true,
          intervalMs: 5000, // 5 seconds
        },
      });

      expect(job).toBeDefined();
      expect(job.schedule?.enabled).toBe(true);
      expect(job.schedule?.intervalMs).toBe(5000);
      expect(job.scheduleState?.nextRunAt).toBeDefined();

      intervalJobId = job.id;
    });

    it("should trigger interval job when nextRunAt is past", async () => {
      // Set nextRunAt to past
      const pastTime = new Date(Date.now() - 2000).toISOString();
      const job = await jobsService.getJob(intervalJobId);

      await jobsService.upsertJob({
        ...job!,
        scheduleState: {
          ...job!.scheduleState,
          nextRunAt: pastTime,
        },
      });

      // Run scheduler tick
      await scheduler.tickNow();

      // Wait for job to complete
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Check job completed
      const updatedJob = await jobsService.getJob(intervalJobId);
      expect(updatedJob?.status).toBe("completed");
    }, 10000);

    it("should advance nextRunAt by intervalMs", async () => {
      const job = await jobsService.getJob(intervalJobId);

      expect(job?.scheduleState?.nextRunAt).toBeDefined();
      expect(job?.scheduleState?.lastTriggeredAt).toBeDefined();

      const nextRunAt = new Date(job!.scheduleState!.nextRunAt!);
      const lastTriggeredAt = new Date(job!.scheduleState!.lastTriggeredAt!);

      // nextRunAt should be ~5000ms after lastTriggeredAt
      const deltaMs = nextRunAt.getTime() - lastTriggeredAt.getTime();
      expect(deltaMs).toBeGreaterThanOrEqual(4500);
      expect(deltaMs).toBeLessThanOrEqual(5500);
    });
  });

  describe("Multiple Scheduled Jobs", () => {
    it("should handle multiple jobs with different schedules", async () => {
      // Create 3 jobs with different schedules
      const job1 = await jobsService.createJob({
        name: "Multi Job 1",
        appIds: [STANDALONE_APP_ID],
        type: "shell",
        command: 'echo "Job 1"',
        schedule: {
          enabled: true,
          cron: "* * * * *",
        },
      });

      const job2 = await jobsService.createJob({
        name: "Multi Job 2",
        appIds: [STANDALONE_APP_ID],
        type: "shell",
        command: 'echo "Job 2"',
        schedule: {
          enabled: true,
          intervalMs: 10000,
        },
      });

      const job3 = await jobsService.createJob({
        name: "Multi Job 3",
        appIds: [STANDALONE_APP_ID],
        type: "shell",
        command: 'echo "Job 3"',
        schedule: {
          enabled: true,
          cron: "*/2 * * * *",
        },
      });

      // Set all to trigger immediately
      const pastTime = new Date(Date.now() - 1000).toISOString();
      for (const job of [job1, job2, job3]) {
        await jobsService.upsertJob({
          ...job,
          scheduleState: {
            ...job.scheduleState,
            nextRunAt: pastTime,
          },
        });
      }

      // Run scheduler tick
      await scheduler.tickNow();

      // Wait for all jobs to complete
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Check all jobs completed
      const updatedJob1 = await jobsService.getJob(job1.id);
      const updatedJob2 = await jobsService.getJob(job2.id);
      const updatedJob3 = await jobsService.getJob(job3.id);

      expect(updatedJob1?.status).toBe("completed");
      expect(updatedJob2?.status).toBe("completed");
      expect(updatedJob3?.status).toBe("completed");
    }, 15000);
  });

  describe("Disabled Schedule", () => {
    let disabledJobId: string;

    it("should not run job when schedule is disabled", async () => {
      const job = await jobsService.createJob({
        name: "Disabled Schedule Job",
        appIds: [STANDALONE_APP_ID],
        type: "shell",
        command: 'echo "Should not run"',
        schedule: {
          enabled: false,
          cron: "* * * * *",
        },
      });

      disabledJobId = job.id;

      // Set nextRunAt to past
      const pastTime = new Date(Date.now() - 1000).toISOString();
      await jobsService.upsertJob({
        ...job,
        scheduleState: {
          nextRunAt: pastTime,
        },
      });

      // Run scheduler tick
      await scheduler.tickNow();

      // Wait briefly
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Job should still be pending (not run)
      const updatedJob = await jobsService.getJob(disabledJobId);
      expect(updatedJob?.status).toBe("pending");
      expect(updatedJob?.lastRunAt).toBeUndefined();
    });
  });
});
