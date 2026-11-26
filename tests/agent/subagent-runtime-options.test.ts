import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  BLANK_SUBAGENT_SYSTEM_PROMPT,
  resolveSubAgentRuntime,
} from "../../src/core/types/subagents.js";
import { filterMemoryBlocksForRuntime } from "../../src/gateway/services/agent/subAgentRuntimeContext.js";
import { AgentJobExecutor } from "../../src/gateway/services/jobs/executors/AgentJobExecutor.js";
import {
  initializeJobsService,
  resetJobsServiceSingletonForTests,
} from "../../src/gateway/services/JobsService.js";
import {
  getSubAgentService,
  resetSubAgentServiceForWorkspaceSwitch,
} from "../../src/gateway/services/SubAgentService.js";
import type { JobRecord } from "../../src/gateway/services/jobs/types.js";

const UNUSED = { shell: "", bash: "", node: "", python: "", swift: "" } as const;

describe("resolveSubAgentRuntime", () => {
  it("defaults to the full Pen runtime", () => {
    expect(resolveSubAgentRuntime(undefined)).toEqual({
      systemPromptMode: "append",
      memoryContext: true,
      wikiContext: true,
      tools: true,
      nativeWebSearch: true,
      promptCaching: true,
      contextTrimming: true,
    });
  });

  it("keeps caching and trimming on when only context switches are set", () => {
    const r = resolveSubAgentRuntime({
      systemPromptMode: "replace",
      memoryContext: false,
      wikiContext: false,
      tools: false,
    });
    expect(r.promptCaching).toBe(true);
    expect(r.contextTrimming).toBe(true);
    expect(r.tools).toBe(false);
  });
});

describe("filterMemoryBlocksForRuntime", () => {
  const wiki = "[WIKI GRAPH — local entity index; use get_wiki_entity for full pages]\n- person/a";
  const goals = "[USER GOALS & OKRs — from Papr]\n- ship";
  const related = "[RELATED MEMORY]\n- something";
  const all = [wiki, goals, related];
  const on = { memoryContext: true, wikiContext: true };

  it("keeps everything when both are on", () => {
    expect(filterMemoryBlocksForRuntime(all, on)).toEqual(all);
  });
  it("drops memory blocks but keeps the wiki", () => {
    expect(filterMemoryBlocksForRuntime(all, { ...on, memoryContext: false })).toEqual([wiki]);
  });
  it("drops the wiki but keeps memory", () => {
    expect(filterMemoryBlocksForRuntime(all, { ...on, wikiContext: false })).toEqual([goals, related]);
  });
  it("drops everything when both are off", () => {
    expect(filterMemoryBlocksForRuntime(all, { memoryContext: false, wikiContext: false })).toEqual([]);
  });
});

describe("AgentJobExecutor replace-mode sub-agents", () => {
  let tempRoot = "";
  const prevHome = process.env.PAPR_HOME;
  const prevMode = process.env.GATEWAY_MODE;

  async function writeJob(subAgentId: string, extra: Partial<JobRecord> = {}) {
    const paprHome = process.env.PAPR_HOME!;
    const job: JobRecord = {
      id: `job-${subAgentId}`,
      name: "Neutral buyer check",
      type: "subagent",
      subAgentId,
      status: "pending",
      appIds: ["__standalone__"],
      command: "Which CRM should a 10-person startup use?",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...extra,
    } as JobRecord;
    await fs.mkdir(path.join(paprHome, "Jobs", job.id, "data"), { recursive: true });
    await fs.writeFile(path.join(paprHome, "data", "jobs.json"), JSON.stringify([job]), "utf8");
    resetJobsServiceSingletonForTests();
    await initializeJobsService();
    const { getJobsService } = await import("../../src/gateway/services/JobsService.js");
    const svc = getJobsService();
    return { job: (await svc.getJob(job.id))!, jobDir: (await svc.getJobPath(job.id))! };
  }

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-runtime-"));
    process.env.PAPR_HOME = path.join(tempRoot, "Papr");
    process.env.GATEWAY_MODE = "cloud_agent";
    await fs.mkdir(path.join(process.env.PAPR_HOME, "data"), { recursive: true });
    resetSubAgentServiceForWorkspaceSwitch();
  });

  afterEach(async () => {
    resetJobsServiceSingletonForTests();
    resetSubAgentServiceForWorkspaceSwitch();
    if (prevHome === undefined) delete process.env.PAPR_HOME;
    else process.env.PAPR_HOME = prevHome;
    if (prevMode === undefined) delete process.env.GATEWAY_MODE;
    else process.env.GATEWAY_MODE = prevMode;
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("uses the profile prompt as the whole system prompt and sends only the task", async () => {
    await getSubAgentService().createOrUpdateAgent({
      id: "neutral-buyer",
      name: "Neutral buyer",
      description: "Asks like a buyer",
      systemPrompt: "You are a helpful assistant.",
      provider: "openai",
      model: "gpt-5-6-sol",
      runtime: { systemPromptMode: "replace", memoryContext: false, wikiContext: false, tools: false },
    });
    const { job, jobDir } = await writeJob("neutral-buyer");
    const session = await new AgentJobExecutor().buildSessionInput({
      runId: "r1", job, jobDir, defaultCommandByType: UNUSED, appendLog: async () => undefined,
    });
    expect(session.systemPromptOverride).toBe("You are a helpful assistant.");
    expect(session.prompt).toBe("Which CRM should a 10-person startup use?");
    expect(session.prompt).not.toContain("JOB ENVIRONMENT");
    expect(session.prompt).not.toContain("[Sub-Agent:");
    expect(session.runtime?.tools).toBe(false);
  });

  it("keeps the job environment when tools stay on, and a blank prompt becomes neutral", async () => {
    await getSubAgentService().createOrUpdateAgent({
      id: "scorer",
      name: "Scorer",
      description: "Scores rows",
      systemPrompt: "",
      runtime: { systemPromptMode: "replace" },
    });
    const { job, jobDir } = await writeJob("scorer");
    const session = await new AgentJobExecutor().buildSessionInput({
      runId: "r2", job, jobDir, defaultCommandByType: UNUSED, appendLog: async () => undefined,
    });
    expect(session.systemPromptOverride).toBe(BLANK_SUBAGENT_SYSTEM_PROMPT);
    expect(session.prompt).toContain("=== JOB ENVIRONMENT ===");
    expect(session.prompt).toContain("Task:\nWhich CRM");
  });

  it("append mode (default) is unchanged: no override, Pen-style sub-agent prompt", async () => {
    await getSubAgentService().createOrUpdateAgent({
      id: "researcher",
      name: "Researcher",
      description: "Research",
      systemPrompt: "Research things.",
    });
    const { job, jobDir } = await writeJob("researcher");
    const session = await new AgentJobExecutor().buildSessionInput({
      runId: "r3", job, jobDir, defaultCommandByType: UNUSED, appendLog: async () => undefined,
    });
    expect(session.systemPromptOverride).toBeUndefined();
    expect(session.prompt).toContain("[Sub-Agent: Researcher]");
    expect(session.prompt).toContain("Research things.");
  });
});
