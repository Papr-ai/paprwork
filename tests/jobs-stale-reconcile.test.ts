import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { getJobsService } from "../src/gateway/services/JobsService.js";
import type { JobRecord } from "../src/gateway/services/JobsService.js";

describe("JobsService - Stale Running Job Reconciliation", () => {
  const jobsService = getJobsService();

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("marks stale running job as failed when no process is tracked", async () => {
    const now = Date.now();
    vi.setSystemTime(now);

    const staleJob: JobRecord = {
      id: "stale-job-1",
      name: "Stale Job",
      type: "shell",
      status: "running",
      command: "echo test",
      lastRunAt: new Date(now - 60_000).toISOString(),
      createdAt: new Date(now - 120_000).toISOString(),
      updatedAt: new Date(now - 60_000).toISOString(),
    };

    const getJobSpy = vi
      .spyOn(jobsService.jobs as any, "entries")
      .mockReturnValue([[staleJob.id, staleJob]]);
    const runningSpy = vi
      .spyOn(jobsService.running as any, "has")
      .mockReturnValue(false);
    const setStatusSpy = vi
      .spyOn(jobsService as any, "setJobStatus")
      .mockResolvedValue({ ...staleJob, status: "failed" });
    const appendLogSpy = vi
      .spyOn(jobsService as any, "appendLog")
      .mockResolvedValue(undefined);

    await jobsService.reconcileStaleRunningJobs(20_000);

    expect(setStatusSpy).toHaveBeenCalledWith(
      staleJob.id,
      "failed",
      expect.objectContaining({
        error: expect.stringContaining("Stale running state"),
        currentExecutionId: undefined,
      }),
    );
    expect(appendLogSpy).toHaveBeenCalled();
  });

  test("skips recent running jobs (under minStaleMs)", async () => {
    const now = Date.now();
    vi.setSystemTime(now);

    const recentJob: JobRecord = {
      id: "recent-job-1",
      name: "Recent Job",
      type: "shell",
      status: "running",
      command: "echo test",
      lastRunAt: new Date(now - 5_000).toISOString(),
      createdAt: new Date(now - 10_000).toISOString(),
      updatedAt: new Date(now - 5_000).toISOString(),
    };

    const getJobSpy = vi
      .spyOn(jobsService.jobs as any, "entries")
      .mockReturnValue([[recentJob.id, recentJob]]);
    const runningSpy = vi
      .spyOn(jobsService.running as any, "has")
      .mockReturnValue(false);
    const setStatusSpy = vi.spyOn(jobsService as any, "setJobStatus");

    await jobsService.reconcileStaleRunningJobs(20_000);

    expect(setStatusSpy).not.toHaveBeenCalled();
  });

  test("skips agent jobs (no child process)", async () => {
    const now = Date.now();
    vi.setSystemTime(now);

    const agentJob: JobRecord = {
      id: "agent-job-1",
      name: "Agent Job",
      type: "agent",
      status: "running",
      command: "do something",
      lastRunAt: new Date(now - 60_000).toISOString(),
      createdAt: new Date(now - 120_000).toISOString(),
      updatedAt: new Date(now - 60_000).toISOString(),
    };

    const getJobSpy = vi
      .spyOn(jobsService.jobs as any, "entries")
      .mockReturnValue([[agentJob.id, agentJob]]);
    const runningSpy = vi
      .spyOn(jobsService.running as any, "has")
      .mockReturnValue(false);
    const setStatusSpy = vi.spyOn(jobsService as any, "setJobStatus");

    await jobsService.reconcileStaleRunningJobs(20_000);

    expect(setStatusSpy).not.toHaveBeenCalled();
  });
});
