import { describe, expect, test, vi } from "vitest";
import { getJobsService } from "../src/gateway/services/JobsService.js";
import { JobsScheduler } from "../src/gateway/services/JobsScheduler.js";
import type { JobRecord } from "../src/gateway/services/JobsService.js";
import * as cloudSchedulerAuthority from "../src/gateway/utils/cloudSchedulerAuthority.js";
import * as jobSchedulerRunLease from "../src/gateway/services/jobs/jobSchedulerRunLease.js";

describe("JobsScheduler", () => {
  test("runs due interval job through JobsService", async () => {
    vi.spyOn(cloudSchedulerAuthority, "isCloudSchedulerAuthoritative").mockResolvedValue(
      false,
    );
    vi.spyOn(jobSchedulerRunLease, "tryAcquireSchedulerRunLease").mockResolvedValue({
      acquired: true,
      runId: "run-test",
    });
    vi.spyOn(jobSchedulerRunLease, "releaseSchedulerRunLease").mockResolvedValue(
      undefined,
    );
    const scheduler = new JobsScheduler();
    const jobsService = getJobsService();
    const now = Date.now();
    const dueJob: JobRecord = {
      id: "job-scheduled-1",
      name: "Scheduled Job",
      type: "shell",
      status: "pending",
      appIds: ["__standalone__"],
      command: "echo hi",
      schedule: {
        enabled: true,
        intervalMs: 1000,
      },
      scheduleState: {
        nextRunAt: new Date(now - 1000).toISOString(),
      },
      createdAt: new Date(now - 5000).toISOString(),
      updatedAt: new Date(now - 5000).toISOString(),
    };

    const initializeSpy = vi
      .spyOn(jobsService, "initialize")
      .mockResolvedValue(undefined);
    const listSpy = vi.spyOn(jobsService, "listJobs").mockResolvedValue([dueJob]);
    const runSpy = vi
      .spyOn(jobsService, "runJobFromScheduler")
      .mockResolvedValue({
        ...dueJob,
        status: "completed",
      });
    const completedAt = new Date(now).toISOString();
    const upsertSpy = vi
      .spyOn(jobsService, "upsertJob")
      .mockResolvedValue(dueJob);

    const getJobSpy = vi.spyOn(jobsService, "getJob").mockResolvedValue({
      ...dueJob,
      status: "completed",
      scheduleState: {
        ...dueJob.scheduleState,
        lastScheduledRunAt: completedAt,
        lastTriggeredAt: completedAt,
      },
    });

    await scheduler.tickNow();

    const dueAt = dueJob.scheduleState?.nextRunAt;
    expect(dueAt).toBeDefined();
    expect(initializeSpy).toHaveBeenCalledOnce();
    expect(listSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(runSpy).toHaveBeenCalledOnce();
    expect(runSpy).toHaveBeenCalledWith(dueJob.id, dueAt);
    expect(getJobSpy).toHaveBeenCalledOnce();
    expect(upsertSpy).toHaveBeenCalledOnce();

    initializeSpy.mockRestore();
    listSpy.mockRestore();
    runSpy.mockRestore();
    getJobSpy.mockRestore();
    upsertSpy.mockRestore();
    vi.restoreAllMocks();
  });

  test("runs due cron job through JobsService and persists next cron slot", async () => {
    vi.spyOn(cloudSchedulerAuthority, "isCloudSchedulerAuthoritative").mockResolvedValue(
      false,
    );
    vi.spyOn(jobSchedulerRunLease, "tryAcquireSchedulerRunLease").mockResolvedValue({
      acquired: true,
      runId: "run-test",
    });
    vi.spyOn(jobSchedulerRunLease, "releaseSchedulerRunLease").mockResolvedValue(
      undefined,
    );
    const scheduler = new JobsScheduler();
    const jobsService = getJobsService();
    const now = Date.now();
    const dueAt = new Date(now - 60_000).toISOString();
    const dueJob: JobRecord = {
      id: "job-cron-1",
      name: "Cron Job",
      type: "shell",
      status: "pending",
      appIds: ["__standalone__"],
      command: "echo cron",
      schedule: {
        enabled: true,
        cron: "* * * * *",
      },
      scheduleState: {
        nextRunAt: dueAt,
      },
      createdAt: new Date(now - 5000).toISOString(),
      updatedAt: new Date(now - 5000).toISOString(),
    };

    const initializeSpy = vi
      .spyOn(jobsService, "initialize")
      .mockResolvedValue(undefined);
    const listSpy = vi.spyOn(jobsService, "listJobs").mockResolvedValue([dueJob]);
    const runSpy = vi
      .spyOn(jobsService, "runJobFromScheduler")
      .mockResolvedValue({
        ...dueJob,
        status: "completed",
      });
    const completedAt = new Date(now).toISOString();
    const upsertSpy = vi
      .spyOn(jobsService, "upsertJob")
      .mockResolvedValue(dueJob);

    const getJobSpy = vi.spyOn(jobsService, "getJob").mockResolvedValue({
      ...dueJob,
      status: "completed",
      scheduleState: {
        ...dueJob.scheduleState,
        lastScheduledRunAt: completedAt,
        lastTriggeredAt: completedAt,
      },
    });

    const beforeTick = Date.now();
    await scheduler.tickNow();

    expect(initializeSpy).toHaveBeenCalledOnce();
    expect(listSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(runSpy).toHaveBeenCalledOnce();
    expect(runSpy).toHaveBeenCalledWith(dueJob.id, dueAt);
    expect(getJobSpy).toHaveBeenCalledOnce();
    expect(upsertSpy).toHaveBeenCalledOnce();

    const upsertArg = upsertSpy.mock.calls[0]?.[0];
    expect(upsertArg?.schedule?.cron).toBe("* * * * *");
    expect(upsertArg?.scheduleState?.nextRunAt).toBeDefined();
    const nextMs = new Date(upsertArg!.scheduleState!.nextRunAt!).getTime();
    expect(Number.isNaN(nextMs)).toBe(false);
    expect(nextMs).toBeGreaterThan(new Date(dueAt).getTime());

    initializeSpy.mockRestore();
    listSpy.mockRestore();
    runSpy.mockRestore();
    getJobSpy.mockRestore();
    upsertSpy.mockRestore();
    vi.restoreAllMocks();
  });

  test("defers cloud-preferred jobs when cloud scheduler is authoritative", async () => {
    vi.spyOn(cloudSchedulerAuthority, "isCloudSchedulerAuthoritative").mockResolvedValue(
      true,
    );
    const scheduler = new JobsScheduler();
    const jobsService = getJobsService();
    const now = Date.now();
    const dueJob: JobRecord = {
      id: "job-cloud-preferred",
      name: "Cloud Preferred Job",
      type: "shell",
      status: "pending",
      appIds: ["__standalone__"],
      command: "echo cloud",
      executionCapability: "cloud-preferred",
      schedule: {
        enabled: true,
        intervalMs: 60_000,
      },
      scheduleState: {
        nextRunAt: new Date(now - 1000).toISOString(),
      },
      createdAt: new Date(now - 5000).toISOString(),
      updatedAt: new Date(now - 5000).toISOString(),
    };

    vi.spyOn(jobsService, "initialize").mockResolvedValue(undefined);
    vi.spyOn(jobsService, "listJobs").mockResolvedValue([dueJob]);
    const runSpy = vi
      .spyOn(jobsService, "runJobFromScheduler")
      .mockResolvedValue({ ...dueJob, status: "completed" });

    await scheduler.tickNow();

    expect(runSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  /**
   * Regression: a failing scheduled job used to leave nextRunAt in the past
   * unless the error matched a narrow allowlist (architecture validation or
   * SQLITE_NOTADB). Every other failure kept the job permanently due, so the
   * scheduler relaunched it on each tick — one job emitted 645k failure events
   * in a single week. Any failure must now advance the schedule.
   */
  test("advances next run after a generic failure so it cannot retry-storm", async () => {
    vi.spyOn(
      cloudSchedulerAuthority,
      "isCloudSchedulerAuthoritative",
    ).mockResolvedValue(false);
    vi.spyOn(
      jobSchedulerRunLease,
      "tryAcquireSchedulerRunLease",
    ).mockResolvedValue({ acquired: true, runId: "run-fail" });
    vi.spyOn(
      jobSchedulerRunLease,
      "releaseSchedulerRunLease",
    ).mockResolvedValue(undefined);

    const scheduler = new JobsScheduler();
    const jobsService = getJobsService();
    const now = Date.now();
    const dueJob: JobRecord = {
      id: "job-failing-1",
      name: "Failing Job",
      type: "shell",
      status: "pending",
      appIds: ["__standalone__"],
      command: "exit 1",
      schedule: { enabled: true, intervalMs: 1000 },
      scheduleState: { nextRunAt: new Date(now - 1000).toISOString() },
      createdAt: new Date(now - 5000).toISOString(),
      updatedAt: new Date(now - 5000).toISOString(),
    };

    vi.spyOn(jobsService, "initialize").mockResolvedValue(undefined);
    vi.spyOn(jobsService, "listJobs").mockResolvedValue([dueJob]);
    // Plain Error: not architecture validation, not SQLITE_NOTADB.
    const runSpy = vi
      .spyOn(jobsService, "runJobFromScheduler")
      .mockRejectedValue(new Error("script exited with code 1"));
    vi.spyOn(jobsService, "getJob").mockResolvedValue(dueJob);
    const upsertSpy = vi
      .spyOn(jobsService, "upsertJob")
      .mockResolvedValue(dueJob);

    await scheduler.tickNow();

    expect(runSpy).toHaveBeenCalledOnce();
    // The schedule was rewritten despite the failure.
    expect(upsertSpy).toHaveBeenCalledOnce();
    const patched = upsertSpy.mock.calls[0]?.[0] as JobRecord | undefined;
    const nextRunAt = patched?.scheduleState?.nextRunAt;
    expect(nextRunAt).toBeDefined();
    expect(new Date(String(nextRunAt)).getTime()).toBeGreaterThan(now - 1000);

    vi.restoreAllMocks();
  });

  test("still runs a failing job again on its next scheduled slot", async () => {
    vi.spyOn(
      cloudSchedulerAuthority,
      "isCloudSchedulerAuthoritative",
    ).mockResolvedValue(false);
    vi.spyOn(
      jobSchedulerRunLease,
      "tryAcquireSchedulerRunLease",
    ).mockResolvedValue({ acquired: true, runId: "run-fail-2" });
    vi.spyOn(
      jobSchedulerRunLease,
      "releaseSchedulerRunLease",
    ).mockResolvedValue(undefined);

    const scheduler = new JobsScheduler();
    const jobsService = getJobsService();
    const now = Date.now();
    // Already due again: advancing the schedule must not disable the job.
    const dueJob: JobRecord = {
      id: "job-failing-2",
      name: "Failing Job",
      type: "shell",
      status: "pending",
      appIds: ["__standalone__"],
      command: "exit 1",
      schedule: { enabled: true, intervalMs: 1000 },
      scheduleState: { nextRunAt: new Date(now - 1000).toISOString() },
      createdAt: new Date(now - 5000).toISOString(),
      updatedAt: new Date(now - 5000).toISOString(),
    };

    vi.spyOn(jobsService, "initialize").mockResolvedValue(undefined);
    vi.spyOn(jobsService, "listJobs").mockResolvedValue([dueJob]);
    const runSpy = vi
      .spyOn(jobsService, "runJobFromScheduler")
      .mockRejectedValue(new Error("still broken"));
    vi.spyOn(jobsService, "getJob").mockResolvedValue(dueJob);
    const upsertSpy = vi
      .spyOn(jobsService, "upsertJob")
      .mockResolvedValue(dueJob);

    await scheduler.tickNow();

    // Failure advances the slot but leaves the schedule enabled, so recovery
    // after a transient outage still happens on the next tick.
    expect(upsertSpy).toHaveBeenCalledOnce();
    const patched = upsertSpy.mock.calls[0]?.[0] as JobRecord | undefined;
    expect(patched?.schedule?.enabled).toBe(true);
    expect(runSpy).toHaveBeenCalledOnce();

    vi.restoreAllMocks();
  });
});
