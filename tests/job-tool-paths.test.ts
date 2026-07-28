import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  ensureWorkspaceLayout,
  resolveOrgNamespaceWorkspacePath,
} from "../src/core/utils/paprWorkspace.js";
import { getPaprJobsRoot } from "../src/core/utils/paprRoot.js";
import {
  getJobsService,
  resetJobsServiceSingletonForTests,
} from "../src/gateway/services/JobsService.js";
import { STANDALONE_APP_ID } from "../src/gateway/services/jobs/appIds.js";
import {
  listJobFilesTool,
  listJobsTool,
  readJobFileTool,
  runEditJobFile,
} from "../src/core/tools/appJobs.js";

describe("job tool paths (org/namespace workspace)", () => {
  let tempHome = "";
  let previousHome: string | undefined;
  let jobId = "";

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "job-tool-paths-"));
    previousHome = process.env.HOME;
    process.env.HOME = tempHome;
    delete process.env.PAPR_HOME;

    resetJobsServiceSingletonForTests();
    await ensureWorkspaceLayout({
      organizationId: "org-test",
      namespaceId: "ns-test",
      organizationName: "Test Org",
      namespaceName: "Test NS",
    });

    const jobsService = getJobsService();
    await jobsService.initialize();
    const job = await jobsService.createJob({
      name: "Attention fetch",
      appIds: [STANDALONE_APP_ID],
      type: "python",
      command: "python3 code/fetch_myadvice_meetings.py --api-key ${RR_ATTENTION_API_KEY}",
    });
    jobId = job.id;

    const scriptPath = path.join(
      getPaprJobsRoot(),
      jobId,
      "code",
      "fetch_myadvice_meetings.py",
    );
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    await fs.writeFile(scriptPath, "print('ok')\n", "utf8");
  });

  afterEach(async () => {
    resetJobsServiceSingletonForTests();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    delete process.env.PAPR_HOME;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("list_jobs returns dir under active org/namespace Jobs root", async () => {
    const result = await listJobsTool.execute({});
    expect(result.success).toBe(true);
    const data = result.data as { jobs: Array<{ id: string; dir: string }> };
    const entry = data.jobs.find((j) => j.id === jobId);
    expect(entry).toBeDefined();
    expect(entry!.dir).toBe(
      path.join(
        resolveOrgNamespaceWorkspacePath("org-test", "ns-test"),
        "Jobs",
        jobId,
      ),
    );
    expect(entry!.dir).not.toContain(`${path.sep}jobs${path.sep}`);
  });

  it("list_job_files discovers scripts under workspace job dir", async () => {
    const result = await listJobFilesTool.execute({ jobId });
    expect(result.success).toBe(true);
    const data = result.data as { files: string[] };
    expect(data.files).toContain("code/fetch_myadvice_meetings.py");
  });

  it("read_job_file reads from workspace job dir", async () => {
    const result = await readJobFileTool.execute({
      jobId,
      filename: "code/fetch_myadvice_meetings.py",
    });
    expect(result.success).toBe(true);
    const data = result.data as { content: string; path: string };
    expect(data.content).toContain("print('ok')");
    expect(data.path).toContain(
      path.join("orgs", "org-test", "namespaces", "ns-test", "Jobs", jobId),
    );
  });

  it("runEditJobFile patches files in workspace job dir", async () => {
    const result = await runEditJobFile({
      jobId,
      filename: "code/fetch_myadvice_meetings.py",
      oldString: "print('ok')",
      newString: "print('patched')",
    });
    expect(result.success).toBe(true);

    const onDisk = await fs.readFile(
      path.join(getPaprJobsRoot(), jobId, "code", "fetch_myadvice_meetings.py"),
      "utf8",
    );
    expect(onDisk).toBe("print('patched')\n");
  });
});
