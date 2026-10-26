import { beforeEach, describe, expect, it, vi } from "vitest";

const pushNow = vi.fn();
const pushGitNow = vi.fn(async () => ({ pushedPaths: [], skippedPaths: [], scope: "job" }));
const pushLinkedSourceIfNeeded = vi.fn(async () => null);
const listLinkedSources = vi.fn(async () => [
  { jobId: "job-1", dbPath: "/tmp/job-1.db", alias: "a", appId: "app-1" },
  { dbId: "db-other", dbPath: "/tmp/other.db", alias: "b", appId: "app-2" },
]);
const cloudApiFetch = vi.fn();
const appendFile = vi.fn(async () => undefined);

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
    applyCloudRunPatch: vi.fn(async () => job),
  };
}

describe("runJobInCloud", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pushes only the job, its apps and its own database — never the whole workspace", async () => {
    cloudApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ jobId: "job-1", status: "completed", exitCode: 0, stdout: "ok", stderr: "" }),
    });
    const { runJobInCloud } = await import("./CloudJobRunService.js");
    await runJobInCloud(makeJobsService() as never, "job-1");

    expect(pushNow).not.toHaveBeenCalled();
    expect(pushGitNow).toHaveBeenCalledWith({ jobId: "job-1", skipPostSyncHooks: true });
    expect(pushGitNow).toHaveBeenCalledWith({ appId: "app-1", skipPostSyncHooks: true });
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

    const statuses = service.applyCloudRunPatch.mock.calls.map((c) => (c[0] as { status: string }).status);
    expect(statuses).toEqual(["running", "failed"]);
    const logged = appendFile.mock.calls.map((c) => String(c[1])).join("");
    expect(logged).toContain("Cloud run started");
    expect(logged).toContain("Cloud run failed: Request timed out");
  });
});
