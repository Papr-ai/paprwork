/**
 * GitHub #139 bugs 2 + 3:
 *  - /api/jobs/run must not report "running" for a job whose spawn failed
 *  - a phantom `running` flag must be clearable and must not re-anchor the
 *    stale watchdog on every retry
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getJobsService } from "../src/gateway/services/JobsService.js";
import type { JobRecord } from "../src/gateway/services/JobsService.js";

type Svc = ReturnType<typeof getJobsService> & {
  jobs: Map<string, JobRecord>;
  running: Map<string, unknown>;
  agentRuns: Map<string, unknown>;
  launchFailures: Map<string, { runId: string; error: string }>;
};

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  const now = new Date().toISOString();
  return {
    id: "job-spawn-1",
    name: "Spawn test",
    type: "python",
    status: "pending",
    command: "python3 main.py",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as JobRecord;
}

describe("JobsService spawn-failure reporting (#139)", () => {
  const svc = getJobsService() as unknown as Svc;
  let appendLog: ReturnType<typeof vi.spyOn>;
  let getJob: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    svc.jobs.clear();
    svc.running.clear();
    svc.agentRuns.clear();
    svc.launchFailures.clear();
    appendLog = vi.spyOn(svc as never, "appendLog" as never).mockResolvedValue(undefined as never);
    // Keep status writes in memory only — no disk, no cloud patch.
    vi.spyOn(svc as never, "saveJobs" as never).mockResolvedValue(undefined as never);
    getJob = vi.spyOn(svc, "getJob").mockImplementation(async (id: string) => svc.jobs.get(id));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("clearStaleRunningState flips a phantom running job to failed", async () => {
    svc.jobs.set("job-spawn-1", makeJob({ status: "running", runSessionStartedAt: new Date().toISOString() }));
    const setStatus = vi
      .spyOn(svc as never, "setJobStatus" as never)
      .mockImplementation(async (id: string, status: string, updates: Partial<JobRecord>) => {
        const next = { ...svc.jobs.get(id)!, ...updates, status } as JobRecord;
        svc.jobs.set(id, next);
        return next;
      });

    expect(await svc.clearStaleRunningState("job-spawn-1")).toBe(true);
    expect(svc.jobs.get("job-spawn-1")?.status).toBe("failed");
    expect(setStatus).toHaveBeenCalledWith(
      "job-spawn-1",
      "failed",
      expect.objectContaining({ runSessionStartedAt: undefined, currentExecutionId: undefined }),
    );
    expect(appendLog).toHaveBeenCalled();
  });

  test("clearStaleRunningState refuses when a process is genuinely tracked", async () => {
    svc.jobs.set("job-spawn-1", makeJob({ status: "running" }));
    svc.running.set("job-spawn-1", { pid: 1 });
    expect(await svc.clearStaleRunningState("job-spawn-1")).toBe(false);
    expect(svc.jobs.get("job-spawn-1")?.status).toBe("running");
  });

  test("clearStaleRunningState is a no-op for non-running jobs", async () => {
    svc.jobs.set("job-spawn-1", makeJob({ status: "completed" }));
    expect(await svc.clearStaleRunningState("job-spawn-1")).toBe(false);
  });

  test("startJobRunForApi returns failed (not running) when the launch fails", async () => {
    svc.jobs.set("job-spawn-1", makeJob());
    vi.spyOn(svc as never, "preflightJobRun" as never).mockResolvedValue(undefined as never);
    // Simulate runJob: persist "running" first (as the real loop does), then
    // the executor throws spawn EBADF and the launch failure is recorded.
    vi.spyOn(svc, "runJob").mockImplementation(async (id: string) => {
      const running = { ...svc.jobs.get(id)!, status: "running", currentExecutionId: "run-1" } as JobRecord;
      svc.jobs.set(id, running);
      await new Promise((r) => setTimeout(r, 30));
      svc.launchFailures.set(id, { runId: "run-1", error: "spawn EBADF" });
      const failed = { ...running, status: "failed", error: "spawn EBADF" } as JobRecord;
      svc.jobs.set(id, failed);
      return failed;
    });

    const result = await svc.startJobRunForApi("job-spawn-1");
    expect(result.status).toBe("failed");
    expect(result.error).toContain("EBADF");
  });

  test("startJobRunForApi returns running only once a process is tracked", async () => {
    svc.jobs.set("job-spawn-1", makeJob());
    vi.spyOn(svc as never, "preflightJobRun" as never).mockResolvedValue(undefined as never);
    let resolveRun!: (v: JobRecord) => void;
    vi.spyOn(svc, "runJob").mockImplementation(async (id: string) => {
      const running = { ...svc.jobs.get(id)!, status: "running", currentExecutionId: "run-2" } as JobRecord;
      svc.jobs.set(id, running);
      // status is "running" but no process yet — API must keep waiting
      await new Promise((r) => setTimeout(r, 120));
      svc.running.set(id, { pid: 4242 });
      return new Promise<JobRecord>((res) => {
        resolveRun = res;
      });
    });

    const started = Date.now();
    const result = await svc.startJobRunForApi("job-spawn-1");
    expect(result.status).toBe("running");
    // Waited for the tracked process, not just for the status write.
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(getJob).toHaveBeenCalled();
    resolveRun({ ...svc.jobs.get("job-spawn-1")!, status: "completed" } as JobRecord);
  });

  test("reloadJobs clears phantom running jobs without touching live ones", async () => {
    const phantom = makeJob({ id: "phantom", status: "running", runSessionStartedAt: new Date().toISOString() });
    const live = makeJob({ id: "live", status: "running" });
    vi.spyOn(svc as never, "loadJobs" as never).mockImplementation(async () => {
      svc.jobs.set("phantom", phantom);
      svc.jobs.set("live", live);
    });
    vi.spyOn(svc as never, "hydrateJobsFromRuntimeFiles" as never).mockResolvedValue(undefined as never);
    vi.spyOn(svc as never, "pruneStaleJobEntries" as never).mockResolvedValue(undefined as never);
    vi.spyOn(svc as never, "reconcileRegistryAfterSync" as never).mockResolvedValue(undefined as never);
    vi.spyOn(svc as never, "setJobStatus" as never).mockImplementation(
      async (id: string, status: string, updates: Partial<JobRecord>) => {
        const next = { ...svc.jobs.get(id)!, ...updates, status } as JobRecord;
        svc.jobs.set(id, next);
        return next;
      },
    );
    svc.running.set("live", { pid: 7 });

    await svc.reloadJobs();

    expect(svc.jobs.get("phantom")?.status).toBe("failed");
    expect(svc.jobs.get("live")?.status).toBe("running");
  });
});
