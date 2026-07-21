import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { AgentJobExecutor } from "../src/gateway/services/jobs/executors/AgentJobExecutor.js";
import { resolveCloudAgentJobStreamInput } from "../src/gateway/services/cloudAgentGateway/cloudAgentRunContext.js";
import {
  initializeJobsService,
  resetJobsServiceSingletonForTests,
} from "../src/gateway/services/JobsService.js";
import type { JobRecord } from "../src/gateway/services/jobs/types.js";

const JOB_ID = "e2e-agent-job-context-001";

const UNUSED_DEFAULT_COMMANDS = {
  shell: "",
  bash: "",
  node: "",
  python: "",
  swift: "",
} as const;

describe("AgentJobExecutor.buildSessionInput", () => {
  let tempRoot = "";
  const previousPaprHome = process.env.PAPR_HOME;
  const previousGatewayMode = process.env.GATEWAY_MODE;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-job-session-"));
    const paprHome = path.join(tempRoot, "Papr");
    process.env.PAPR_HOME = paprHome;
    process.env.GATEWAY_MODE = "cloud_agent";

    const jobDir = path.join(paprHome, "Jobs", JOB_ID);
    await fs.mkdir(path.join(jobDir, "data"), { recursive: true });
    await fs.mkdir(path.join(paprHome, "data"), { recursive: true });

    const job: JobRecord = {
      id: JOB_ID,
      name: "GTM Audit Scorer",
      type: "agent",
      status: "pending",
      appIds: ["__standalone__"],
      command: "Score pending audit requests using recipe.md",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await fs.writeFile(
      path.join(paprHome, "data", "jobs.json"),
      JSON.stringify([job], null, 2),
      "utf8",
    );

    resetJobsServiceSingletonForTests();
    await initializeJobsService();
  });

  afterEach(async () => {
    resetJobsServiceSingletonForTests();
    if (previousPaprHome === undefined) delete process.env.PAPR_HOME;
    else process.env.PAPR_HOME = previousPaprHome;
    if (previousGatewayMode === undefined) delete process.env.GATEWAY_MODE;
    else process.env.GATEWAY_MODE = previousGatewayMode;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("builds prompt from job.command and env block, not memory fallback text", async () => {
    const jobsService = (await import("../src/gateway/services/JobsService.js")).getJobsService();
    const job = await jobsService.getJob(JOB_ID);
    expect(job).toBeTruthy();

    const jobDir = await jobsService.getJobPath(JOB_ID);
    expect(jobDir).toBeTruthy();

    const executor = new AgentJobExecutor();
    const session = await executor.buildSessionInput({
      runId: "run-test-1",
      job: job!,
      jobDir: jobDir!,
      defaultCommandByType: UNUSED_DEFAULT_COMMANDS,
      appendLog: async () => undefined,
    });

    expect(session.prompt).toContain("=== JOB ENVIRONMENT ===");
    expect(session.prompt).toContain("Score pending audit requests using recipe.md");
    expect(session.prompt).not.toContain('Execute agent job "GTM Audit Scorer" and return key outcomes');
    expect(session.provider).toBe("anthropic");
    expect(session.model).toBe("claude-sonnet-4-6");
  });

  it("resolveCloudAgentJobStreamInput uses executor prompt and runtimeParams.prompt override", async () => {
    const streamInput = await resolveCloudAgentJobStreamInput({
      orgId: "org-test",
      userId: "user-test",
      jobId: JOB_ID,
      runId: "run-test-2",
      provider: "anthropic",
      paprApiKey: "sk-test",
      repoCloneUrl: "https://example.com/repo.git",
      repoToken: "token",
      llmAuth: {
        provider: "anthropic",
        authType: "apiKey",
        token: "anthropic-test-key",
      },
      runtimeParams: {
        prompt: "Process scoring request 42 for audit source audit",
        REQUEST_ID: "42",
      },
    });

    expect(streamInput.prompt).toContain("Process scoring request 42");
    expect(streamInput.prompt).toContain("=== JOB ENVIRONMENT ===");
    expect(streamInput.provider).toBe("anthropic");
    expect(process.env.REQUEST_ID).toBe("42");
  });
});
