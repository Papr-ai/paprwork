import os from "os";
import path from "path";
import { promises as fs } from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runJobInCloud } from "../src/gateway/services/CloudJobRunService.js";
import type { JobRecord } from "../src/gateway/services/jobs/types.js";
import type { JobsService } from "../src/gateway/services/JobsService.js";
import { getPaprRoot } from "../src/core/utils/paprRoot.js";

vi.mock("../src/gateway/utils/cloudApiClient.js", () => ({
  cloudApiFetch: vi.fn(),
}));

vi.mock("../src/gateway/services/CloudSyncService.js", () => ({
  getCloudSyncService: vi.fn(),
}));

vi.mock("../src/gateway/services/jobs/jobRuntimeOffGit.js", () => ({
  isJobRuntimeOffGit: vi.fn().mockReturnValue(false),
}));

import { cloudApiFetch } from "../src/gateway/utils/cloudApiClient.js";
import { getCloudSyncService } from "../src/gateway/services/CloudSyncService.js";
import { isJobRuntimeOffGit } from "../src/gateway/services/jobs/jobRuntimeOffGit.js";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

const tmpRoots: string[] = [];

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    name: "Test job",
    type: "shell",
    command: "echo hi",
    status: "pending",
    appIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeJobsService(
  job: JobRecord,
  extras: Partial<JobsService> = {},
): JobsService {
  return {
    getJob: vi.fn().mockResolvedValue(job),
    reloadJobs: vi.fn().mockResolvedValue(undefined),
    applyCloudRunPatch: vi.fn().mockResolvedValue(job),
    getLogs: vi.fn(),
    ...extras,
  } as unknown as JobsService;
}

afterEach(async () => {
  for (const root of tmpRoots.splice(0, tmpRoots.length)) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  vi.clearAllMocks();
});

describe("runJobInCloud", () => {
  // Keeps fixtures out of the developer's real ~/Papr workspace.
  useIsolatedPaprWorkspace("cloud-job-run");

  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "papr-cloud-job-run-"));
    tmpRoots.push(root);
    process.env.HOME = root;

    vi.mocked(getCloudSyncService).mockReturnValue({
      pushNow: vi.fn().mockResolvedValue(undefined),
      pullNow: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof getCloudSyncService>);
    vi.mocked(isJobRuntimeOffGit).mockReturnValue(false);
  });

  it("pushes git, calls memory job-run API, appends logs, and reloads job", async () => {
    const job = makeJob();
    const service = makeJobsService(job);

    vi.mocked(cloudApiFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          jobId: job.id,
          status: "completed",
          exitCode: 0,
          stdout: "cloud output\n",
          stderr: "",
          backend: "cloud-agent-gateway",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const updated = await runJobInCloud(service, job.id);

    expect(cloudApiFetch).toHaveBeenCalledWith(
      "/v1/cloud/runtime/job-run",
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({
          jobId: job.id,
          tier: "sandbox",
          timeoutMs: 600_000,
        }),
      }),
    );

    const cloudSync = getCloudSyncService();
    expect(cloudSync?.pushNow).toHaveBeenCalled();
    expect(cloudSync?.pullNow).toHaveBeenCalled();
    expect(service.reloadJobs).toHaveBeenCalled();

    const logPath = path.join(getPaprRoot(), "Jobs", job.id, "logs", "run.log");
    const logs = await fs.readFile(logPath, "utf8");
    expect(logs).toContain("Cloud run");
    expect(logs).toContain("cloud output");
    expect(updated).toEqual(job);
  });

  it("applies cloud patch instead of git pull when JOB_RUNTIME_OFF_GIT", async () => {
    vi.mocked(isJobRuntimeOffGit).mockReturnValue(true);

    const job = makeJob();
    const applyCloudRunPatch = vi.fn().mockResolvedValue({
      ...job,
      status: "completed",
    });
    const service = makeJobsService(job, { applyCloudRunPatch });

    vi.mocked(cloudApiFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          jobId: job.id,
          status: "completed",
          exitCode: 0,
          stdout: "cloud output\n",
          stderr: "",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await runJobInCloud(service, job.id);

    expect(applyCloudRunPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job.id,
        status: "completed",
        exitCode: 0,
        source: "cloud_manual",
      }),
    );
    const cloudSync = getCloudSyncService();
    expect(cloudSync?.pullNow).not.toHaveBeenCalled();
    expect(service.reloadJobs).not.toHaveBeenCalled();
  });

  it("uses longer timeout for agent jobs", async () => {
    const job = makeJob({ type: "agent" });
    const service = makeJobsService(job);

    vi.mocked(cloudApiFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          jobId: job.id,
          status: "completed",
          exitCode: 0,
          stdout: "",
          stderr: "",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await runJobInCloud(service, job.id);

    expect(cloudApiFetch).toHaveBeenCalledWith(
      "/v1/cloud/runtime/job-run",
      expect.objectContaining({
        body: expect.objectContaining({ timeoutMs: 1_800_000 }),
      }),
    );
  });

  it("rejects when job is already running locally", async () => {
    const job = makeJob({ status: "running" });
    const service = makeJobsService(job);

    await expect(runJobInCloud(service, job.id)).rejects.toThrow(
      /already running locally/i,
    );
    expect(cloudApiFetch).not.toHaveBeenCalled();
  });

  it("throws when cloud API returns error", async () => {
    const job = makeJob();
    const service = makeJobsService(job);

    vi.mocked(cloudApiFetch).mockResolvedValue(
      new Response("job not found in repo", { status: 404 }),
    );

    await expect(runJobInCloud(service, job.id)).rejects.toThrow(
      /Cloud job run failed \(404\)/i,
    );
  });
});
