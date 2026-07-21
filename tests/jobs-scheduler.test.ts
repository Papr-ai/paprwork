import { describe, expect, test, vi } from "vitest";
import { getJobsService } from "../src/gateway/services/JobsService.js";
import { JobsScheduler } from "../src/gateway/services/JobsScheduler.js";
import type { JobRecord } from "../src/gateway/services/JobsService.js";

describe("JobsScheduler", () => {
  test("runs due interval job through JobsService", async () => {
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
  });

  test("runs due cron job through JobsService and persists next cron slot", async () => {
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
    expect(nextMs).toBeGreaterThan(beforeTick);

    initializeSpy.mockRestore();
    listSpy.mockRestore();
    runSpy.mockRestore();
    getJobSpy.mockRestore();
    upsertSpy.mockRestore();
  });
});
