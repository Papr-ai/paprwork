import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  assessJobScriptPath,
  extractScriptPathFromCommand,
  hasBlockingJobScriptPathIssues,
} from "../src/core/utils/jobScriptPathValidation.js";
import {
  ensureWorkspaceLayout,
} from "../src/core/utils/paprWorkspace.js";
import { getPaprJobsRoot } from "../src/core/utils/paprRoot.js";
import {
  getJobsService,
  resetJobsServiceSingletonForTests,
} from "../src/gateway/services/JobsService.js";
import { STANDALONE_APP_ID } from "../src/gateway/services/jobs/appIds.js";
import { runJobTool } from "../src/core/tools/appJobs.js";

describe("jobScriptPathValidation", () => {
  it("extracts python script path and ignores -c", () => {
    expect(
      extractScriptPathFromCommand(
        "python",
        "python3 code/fetch_myadvice_meetings.py --api-key ${KEY}",
      ),
    ).toBe("code/fetch_myadvice_meetings.py");

    expect(
      extractScriptPathFromCommand("python", "python3 -c \"print('hi')\""),
    ).toBeNull();
  });

  it("extracts node script path", () => {
    expect(
      extractScriptPathFromCommand("node", "node code/index.js --flag"),
    ).toBe("code/index.js");
  });

  it("warns when script is not under code/", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "job-script-"));
    const issues = await assessJobScriptPath(
      "python",
      "python3 fetch.py",
      tempDir,
      { skipMissingFile: true },
    );
    expect(issues.some((i) => i.rule === "job-script-missing-code-prefix")).toBe(
      true,
    );
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("errors when script exists in code/ but command omits code/", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "job-script-"));
    await fs.mkdir(path.join(tempDir, "code"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "code", "fetch.py"), "pass\n");

    const issues = await assessJobScriptPath(
      "python",
      "python3 fetch.py",
      tempDir,
    );
    expect(hasBlockingJobScriptPathIssues(issues)).toBe(true);
    expect(issues.some((i) => i.rule === "job-script-wrong-location")).toBe(
      true,
    );
    expect(issues[0]?.suggestedCommand).toContain("code/fetch.py");
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});

describe("run_job script path preflight", () => {
  let tempHome = "";
  let previousHome: string | undefined;
  let jobId = "";

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "run-job-preflight-"));
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
      name: "Wrong path job",
      appIds: [STANDALONE_APP_ID],
      type: "python",
      command: "python3 fetch_myadvice_meetings.py",
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

  it("blocks run_job when command path does not match code/ script", async () => {
    const result = await runJobTool.execute({ jobId });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("script path preflight failed");
    expect(String(result.error)).toContain("code/fetch_myadvice_meetings.py");
  });
});
