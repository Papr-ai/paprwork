import { beforeEach, describe, expect, it, vi } from "vitest";

const pushNow = vi.fn();
const pushGitNow = vi.fn(async () => ({ pushedPaths: [], skippedPaths: [], scope: "job" }));
const pushLinkedSourceIfNeeded = vi.fn(async () => null);
const listLinkedSources = vi.fn(async () => [
  { jobId: "job-1", dbPath: "/tmp/job-1.db", alias: "a", appId: "app-1" },
  { dbId: "db-other", dbPath: "/tmp/other.db", alias: "b", appId: "app-2" },
]);
const cloudApiFetch = vi.fn();
const appendFile = vi.fn(async (_path: string, _data: string, _enc?: string) => undefined);

vi.mock("node:fs/promises", () => ({
  default: { mkdir: vi.fn(async () => undefined), appendFile },
}));
vi.mock("./CloudSyncService.js", () => ({
  getCloudSyncService: () => ({ pushNow, pushGitNow }),
}));
vi.mock("./TursoSyncBridge.js", () => ({
  ensureTursoSyncBridge: () => ({ enabled: true, listLinkedSources, pushLinkedSourceIfNeeded }),
}));
vi.mock("../utils/cloudApiClient.js", () => ({ cloudApiFetch }));
vi.mock("./gatewayTelemetry.js", () => ({
  getGatewayTelemetry: () => ({ trackFireAndForget: vi.fn() }),
}));

const job = { id: "job-1", name: "Probe", type: "bash", appIds: ["app-1"], status: "pending" };

function makeJobsService() {
  return {
    getJob: vi.fn(async () => job),
    applyCloudRunPatch: vi.fn(async (_patch: { status: string }) => job),
    appendJobRunLog: vi.fn(async (_jobId: string, _line: string) => undefined),
  };
}

describe("runJobInCloud", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pushes only the job and its own database — never the whole workspace", async () => {
    cloudApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ jobId: "job-1", status: "completed", exitCode: 0, stdout: "ok", stderr: "" }),
    });
    const { runJobInCloud } = await import("./CloudJobRunService.js");
    await runJobInCloud(makeJobsService() as never, "job-1");

    expect(pushNow).not.toHaveBeenCalled();
    expect(pushGitNow).toHaveBeenCalledWith({ jobId: "job-1", skipPostSyncHooks: true });
    expect(pushGitNow).toHaveBeenCalledTimes(1);
    expect(pushLinkedSourceIfNeeded).toHaveBeenCalledTimes(1);
    expect(pushLinkedSourceIfNeeded).toHaveBeenCalledWith(
      expect.objectContaining({ dbPath: "/tmp/job-1.db" }),
    );
  });

  it("marks the job running before the request and failed with a log line when the request fails", async () => {
    cloudApiFetch.mockRejectedValue(new Error("Request timed out"));
    const service = makeJobsService();
    const { runJobInCloud } = await import("./CloudJobRunService.js");
    await expect(runJobInCloud(service as never, "job-1")).rejects.toThrow("Request timed out");

    const statuses = service.applyCloudRunPatch.mock.calls.map((c) => c[0].status);
    expect(statuses).toEqual(["running", "failed"]);
    const logged = appendFile.mock.calls.map((c) => String(c[1])).join("");
    expect(logged).toContain("Cloud run started");
    expect(logged).toContain("Cloud run failed: Request timed out");
  });

  it("writes live output while the run is in flight and doesn't repeat it at the end", async () => {
    vi.useFakeTimers();
    let finishRun!: () => void;
    const runDone = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    const logPages = [
      { chunks: [{ seq: 1, text: "step 1\n" }], next: 1 },
      { chunks: [{ seq: 2, text: "step 2\n" }], next: 2 },
      { chunks: [], done: true, next: 3 },
    ];
    const logUrls: string[] = [];
    cloudApiFetch.mockImplementation(async (url: string, opts: { body?: { logRunId?: string } }) => {
      if (url.startsWith("/v1/cloud/runtime/job-run/logs")) {
        logUrls.push(url);
        const page = logPages.shift() ?? { chunks: [], done: true, next: 3 };
        return { ok: true, json: async () => page };
      }
      expect(opts.body?.logRunId).toMatch(/^job-1-/);
      await runDone;
      return {
        ok: true,
        json: async () => ({
          jobId: "job-1", status: "completed", exitCode: 0, stdout: "step 1\nstep 2\n", stderr: "",
        }),
      };
    });
    const service = makeJobsService();
    const { runJobInCloud } = await import("./CloudJobRunService.js");
    const run = runJobInCloud(service as never, "job-1");

    await vi.advanceTimersByTimeAsync(2_100);
    expect(service.appendJobRunLog).toHaveBeenCalledWith("job-1", "step 1");
    finishRun();
    await vi.advanceTimersByTimeAsync(0);
    await run;
    vi.useRealTimers();

    expect(service.appendJobRunLog.mock.calls.map((c) => c[1])).toEqual(["step 1", "step 2"]);
    expect(logUrls[1]).toContain("after=1");
    const finalBlock = appendFile.mock.calls.map((c) => String(c[1])).join("");
    expect(finalBlock).toContain("exitCode=0 status=completed");
    expect(finalBlock).not.toContain("step 1");
  });
});
