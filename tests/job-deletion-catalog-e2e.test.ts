/**
 * Local E2E: deleteJob keeps local registry, tombstones, and cloud metadata in sync.
 */

import os from "os";
import path from "path";
import { promises as fs } from "fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { JobsService } from "../src/gateway/services/JobsService.js";
import { STANDALONE_APP_ID } from "../src/gateway/services/jobs/appIds.js";
import { resetJobsServiceSingletonForTests } from "../src/gateway/services/JobsService.js";
import { resetAppServiceSingletonForTests } from "../src/gateway/services/AppService.js";
import {
  JOB_TOMBSTONES_FILENAME,
  readJobTombstones,
} from "../src/gateway/services/jobs/jobTombstones.js";
import { WORKSPACE_CHAT_JOB_ID } from "../src/core/constants/workspaceChatJob.js";

const uploadJobsIndexToCloud = vi.fn().mockResolvedValue(true);
const retryPendingMetadataUploads = vi.fn().mockResolvedValue(undefined);
const deleteJobRuntimePatch = vi.fn().mockResolvedValue(true);
const deleteCloudJobCatalogEntry = vi.fn().mockResolvedValue(true);

vi.mock("../src/gateway/services/syncV3/MetadataRegistryClient.js", () => ({
  uploadJobsIndexToCloud,
  retryPendingMetadataUploads,
}));

vi.mock("../src/gateway/services/jobs/jobRuntimeCloudUpload.js", () => ({
  deleteJobRuntimePatch,
  fetchCloudJobRuntimePatches: vi.fn().mockResolvedValue([]),
  uploadJobRuntimePatch: vi.fn().mockResolvedValue(true),
}));

vi.mock("../src/gateway/services/jobs/jobCloudSummary.js", () => ({
  deleteCloudJobCatalogEntry,
}));

vi.mock("../src/gateway/services/CloudSyncService.js", () => ({
  getCloudSyncService: () => ({
    enqueueRelativePath: vi.fn(),
    pushNow: vi.fn().mockResolvedValue(undefined),
  }),
}));

const tmpRoots: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const root of tmpRoots.splice(0, tmpRoots.length)) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  resetAppServiceSingletonForTests();
  resetJobsServiceSingletonForTests();
});

async function setupService(): Promise<{ service: JobsService; paprHome: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "papr-job-catalog-e2e-"));
  tmpRoots.push(root);
  const paprHome = path.join(root, "Papr");
  process.env.HOME = root;
  process.env.PAPR_HOME = paprHome;
  await fs.mkdir(path.join(paprHome, "data"), { recursive: true });
  resetAppServiceSingletonForTests();
  resetJobsServiceSingletonForTests();
  const service = new JobsService();
  await service.initialize();
  await service.waitForStartupMaintenance();
  return { service, paprHome };
}

function visibleJobIds(jobs: { id: string }[]): string[] {
  return jobs
    .map((j) => j.id)
    .filter((id) => id !== WORKSPACE_CHAT_JOB_ID)
    .sort();
}

describe("job deletion catalog E2E (local)", () => {
  test("deleteJob removes id from jobs.json, tombstones, and awaits Mongo upload", async () => {
    const { service, paprHome } = await setupService();

    const keep = await service.createJob({
      name: "Keep",
      appIds: [STANDALONE_APP_ID],
      type: "shell",
      command: "echo keep",
    });
    const drop = await service.createJob({
      name: "Drop",
      appIds: [STANDALONE_APP_ID],
      type: "shell",
      command: "echo drop",
    });

    uploadJobsIndexToCloud.mockClear();
    retryPendingMetadataUploads.mockClear();
    deleteJobRuntimePatch.mockClear();
    deleteCloudJobCatalogEntry.mockClear();

    await service.deleteJob(drop.id, true);

    expect(await service.getJob(drop.id)).toBeNull();
    expect(visibleJobIds(await service.listJobs())).toEqual([keep.id]);

    const jobsJson = JSON.parse(
      await fs.readFile(path.join(paprHome, "data", "jobs.json"), "utf8"),
    ) as { id: string }[];
    expect(jobsJson.map((j) => j.id)).not.toContain(drop.id);
    expect(jobsJson.map((j) => j.id)).toContain(keep.id);

    const tombstones = await readJobTombstones(paprHome);
    expect(tombstones.has(drop.id)).toBe(true);

    expect(deleteJobRuntimePatch).toHaveBeenCalledWith(drop.id);
    expect(deleteCloudJobCatalogEntry).toHaveBeenCalledWith(drop.id);

    const deleteUploadCall = uploadJobsIndexToCloud.mock.calls.find((call) => {
      const jobs = call[0] as { id: string }[];
      return jobs.every((j) => j.id !== drop.id) && jobs.some((j) => j.id === keep.id);
    });
    expect(deleteUploadCall).toBeDefined();
    expect(retryPendingMetadataUploads).toHaveBeenCalled();
  });

  test("reloadJobs after git merge drops tombstoned id and re-uploads catalog", async () => {
    const { service, paprHome } = await setupService();

    const job = await service.createJob({
      name: "Ghost",
      appIds: [STANDALONE_APP_ID],
      type: "shell",
      command: "echo ghost",
    });

    await service.deleteJob(job.id, false);

    // Simulate git/metadata merge re-introducing the tombstoned row on disk.
    const jobsPath = path.join(paprHome, "data", "jobs.json");
    const list = JSON.parse(await fs.readFile(jobsPath, "utf8")) as Record<string, unknown>[];
    list.push({
      id: job.id,
      name: "Ghost re-imported",
      type: "shell",
      command: "echo ghost",
      appIds: [STANDALONE_APP_ID],
      updatedAt: new Date().toISOString(),
    });
    await fs.writeFile(jobsPath, JSON.stringify(list, null, 2), "utf8");

    uploadJobsIndexToCloud.mockClear();
    retryPendingMetadataUploads.mockClear();

    await service.reloadJobs();

    expect(await service.getJob(job.id)).toBeNull();
    expect(uploadJobsIndexToCloud).toHaveBeenCalled();
    expect(retryPendingMetadataUploads).toHaveBeenCalled();

    const tombstonesRaw = await fs.readFile(
      path.join(paprHome, "data", JOB_TOMBSTONES_FILENAME),
      "utf8",
    );
    expect(tombstonesRaw).toContain(job.id);
  });
});
