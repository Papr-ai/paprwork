/**
 * Deleted jobs must never come back from a leftover Jobs/<id>/ folder —
 * regardless of local-only scope, cloud failures, or migration archives.
 */

import os from "os";
import path from "path";
import { existsSync, promises as fs } from "fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { JobsService, resetJobsServiceSingletonForTests } from "../src/gateway/services/JobsService.js";
import { resetAppServiceSingletonForTests } from "../src/gateway/services/AppService.js";
import { STANDALONE_APP_ID } from "../src/gateway/services/jobs/appIds.js";
import { readJobTombstones } from "../src/gateway/services/jobs/jobTombstones.js";

const deleteJobRuntimePatch = vi.fn().mockResolvedValue(true);
const deleteCloudJobCatalogEntry = vi.fn().mockResolvedValue(true);
const resolveJobDeleteScope = vi.fn();

vi.mock("../src/gateway/services/syncV3/MetadataRegistryClient.js", () => ({
  uploadJobsIndexToCloud: vi.fn().mockResolvedValue(true),
  retryPendingMetadataUploads: vi.fn().mockResolvedValue(undefined),
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
vi.mock("../src/gateway/services/appDeleteScope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/gateway/services/appDeleteScope.js")>();
  return {
    ...actual,
    resolveJobDeleteScope: (...args: Parameters<typeof actual.resolveJobDeleteScope>) =>
      resolveJobDeleteScope(...args) ?? actual.resolveJobDeleteScope(...args),
  };
});

const tmpRoots: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  resolveJobDeleteScope.mockReset();
  await new Promise((r) => setTimeout(r, 50));
  for (const root of tmpRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  resetAppServiceSingletonForTests();
  resetJobsServiceSingletonForTests();
});

async function boot(paprHome?: string): Promise<{ service: JobsService; paprHome: string }> {
  if (!paprHome) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "papr-job-resurrect-"));
    tmpRoots.push(root);
    paprHome = path.join(root, "Papr");
    process.env.HOME = root;
    process.env.PAPR_HOME = paprHome;
    await fs.mkdir(path.join(paprHome, "data"), { recursive: true });
  }
  resetAppServiceSingletonForTests();
  resetJobsServiceSingletonForTests();
  const service = new JobsService();
  await service.initialize();
  await service.waitForStartupMaintenance();
  return { service, paprHome };
}

async function makeJob(service: JobsService, name: string) {
  return service.createJob({
    name,
    appIds: [STANDALONE_APP_ID],
    type: "shell",
    command: `echo ${name}`,
  });
}

describe("job delete never resurrects", () => {
  test("default delete moves folder to backups/deleted-jobs and tombstones", async () => {
    const { service, paprHome } = await boot();
    const job = await makeJob(service, "drop");

    await service.deleteJob(job.id); // deleteFiles defaults to false

    expect(existsSync(path.join(paprHome, "Jobs", job.id))).toBe(false);
    const archived = await fs.readdir(path.join(paprHome, "backups", "deleted-jobs"));
    expect(archived.some((d) => d.startsWith(job.id))).toBe(true);
    expect((await readJobTombstones(paprHome)).has(job.id)).toBe(true);

    const { service: restarted } = await boot(paprHome);
    expect(await restarted.getJob(job.id)).toBeNull();
  });

  test("collaborator local-only delete still tombstones (no cloud cleanup)", async () => {
    const { service, paprHome } = await boot();
    const job = await makeJob(service, "local-only");
    resolveJobDeleteScope.mockResolvedValue({ localOnly: true, linkedAppIds: [], blockDelete: false });

    const result = await service.deleteJob(job.id);

    expect(result.localOnly).toBe(true);
    expect(deleteCloudJobCatalogEntry).not.toHaveBeenCalled();
    expect((await readJobTombstones(paprHome)).has(job.id)).toBe(true);
  });

  test("tombstone survives cloud cleanup throwing; leftover folder is not revived", async () => {
    const { service, paprHome } = await boot();
    const job = await makeJob(service, "cloud-fails");
    const jobDir = path.join(paprHome, "Jobs", job.id);
    const jobJson = await fs.readFile(path.join(jobDir, "job.json"), "utf8");
    deleteJobRuntimePatch.mockRejectedValueOnce(new Error("network down"));

    await service.deleteJob(job.id);
    expect((await readJobTombstones(paprHome)).has(job.id)).toBe(true);

    // Simulate an old build / sync putting the folder back.
    await fs.mkdir(jobDir, { recursive: true });
    await fs.writeFile(path.join(jobDir, "job.json"), jobJson);

    const { service: restarted } = await boot(paprHome);
    expect(await restarted.getJob(job.id)).toBeNull();
  });

  test("folder whose name differs from its job.json id (e.g. .migrated) is never loaded", async () => {
    const { service, paprHome } = await boot();
    const job = await makeJob(service, "archive-copy");
    const src = path.join(paprHome, "Jobs", job.id);
    const archived = path.join(paprHome, "Jobs", `${job.id}.migrated`);
    await fs.cp(src, archived, { recursive: true });
    await service.deleteJob(job.id, true);
    // Remove the tombstone to prove the name check alone blocks it.
    await fs.writeFile(
      path.join(paprHome, "data", ".job-tombstones.json"),
      JSON.stringify({ removedJobIds: [], updatedAt: new Date().toISOString() }),
    );

    const { service: restarted } = await boot(paprHome);
    expect(await restarted.getJob(job.id)).toBeNull();
    expect((await restarted.listJobs()).some((j) => j.id.includes(".migrated"))).toBe(false);
  });
});
