import { describe, expect, test, beforeEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import { STANDALONE_APP_ID } from "../src/gateway/services/jobs/appIds.js";
import {
  getJobsService,
  resetJobsServiceSingletonForTests,
} from "../src/gateway/services/JobsService.js";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

/**
 * Regression: cloud sync hashes job folders as `mtime:size`. A runtime-only
 * update (scheduled run finishing, status change) used to rewrite job.json with
 * identical bytes, bumping mtime and marking the job permanently "outdated"
 * — the app Web sync panel then reported "0 of N jobs on the web" forever.
 *
 * job.json must only be written when config bytes actually change.
 */
describe("job.json write stability", () => {
  useIsolatedPaprWorkspace();

  beforeEach(async () => {
    resetJobsServiceSingletonForTests();
    await getJobsService().initialize();
  });

  test("runtime-only update does not touch job.json mtime", async () => {
    const jobsService = getJobsService();
    const job = await jobsService.createJob({
      name: "ConfigWriteStability Runtime Job",
      appIds: [STANDALONE_APP_ID],
      type: "bash",
      command: 'echo "noop"',
    });

    const jobDir = await jobsService.getJobPath(job.id);
    expect(jobDir).toBeTruthy();
    const configPath = path.join(jobDir as string, "job.json");

    const before = await fs.stat(configPath);
    const beforeBytes = await fs.readFile(configPath, "utf8");

    // Ensure a real mtime delta would be observable.
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Runtime-only mutation — no config field changes.
    // recordedAt must be newer than job.updatedAt or the patch is a no-op.
    const applied = await jobsService.applyCloudRunPatch({
      jobId: job.id,
      status: "completed",
      lastRunAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      recordedAt: new Date(Date.now() + 1000).toISOString(),
      source: "desktop",
    });
    expect(applied).not.toBeNull();

    const after = await fs.stat(configPath);
    const afterBytes = await fs.readFile(configPath, "utf8");

    expect(afterBytes).toBe(beforeBytes);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  test("config change still rewrites job.json", async () => {
    const jobsService = getJobsService();
    const job = await jobsService.createJob({
      name: "ConfigWriteStability Config Job",
      appIds: [STANDALONE_APP_ID],
      type: "bash",
      command: 'echo "before"',
    });

    const jobDir = await jobsService.getJobPath(job.id);
    const configPath = path.join(jobDir as string, "job.json");
    const beforeBytes = await fs.readFile(configPath, "utf8");

    await jobsService.updateJob(job.id, { command: 'echo "after"' });

    const afterBytes = await fs.readFile(configPath, "utf8");
    expect(afterBytes).not.toBe(beforeBytes);
    expect(afterBytes).toContain("after");
  });
});
