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
    const upsertSpy = vi
      .spyOn(jobsService, "upsertJob")
      .mockResolvedValue(dueJob);

    await scheduler.tickNow();

    expect(initializeSpy).toHaveBeenCalledOnce();
    expect(listSpy).toHaveBeenCalledOnce();
    expect(runSpy).toHaveBeenCalledOnce();
    expect(upsertSpy).toHaveBeenCalledOnce();

    initializeSpy.mockRestore();
    listSpy.mockRestore();
    runSpy.mockRestore();
    upsertSpy.mockRestore();
  });
});
