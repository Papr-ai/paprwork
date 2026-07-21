import fs from "fs/promises";
import { STANDALONE_APP_ID } from "../src/gateway/services/jobs/appIds.js";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { getJobsService } from "../src/gateway/services/JobsService.js";
import type { JobRecord } from "../src/gateway/services/JobsService.js";
import { SubAgentService, toSubAgentListSummaries } from "../src/gateway/services/SubAgentService.js";

describe("SubAgentService", () => {
  const root = path.join(os.tmpdir(), `paprwork-v2-subagents-${Date.now()}`);
  const home = path.join(root, "home");
  const originalHome = process.env.HOME;

  beforeAll(async () => {
    process.env.HOME = home;
    await fs.mkdir(home, { recursive: true });
  });

  afterAll(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  test("loads default sub-agents and supports create/update", async () => {
    const service = new SubAgentService();
    await service.initialize();

    const initial = await service.listAgents();
    expect(initial.length).toBeGreaterThan(0);
    expect(initial.some((a) => a.id === "product-architect")).toBe(true);

    const summaries = toSubAgentListSummaries(initial);
    expect(summaries.some((a) => a.id === "product-architect")).toBe(true);
    expect(summaries[0]?.builtIn).toBe(true);
    expect(JSON.stringify(summaries).length).toBeLessThan(20_000);
    for (const summary of summaries) {
      expect(summary).not.toHaveProperty("systemPrompt");
    }

    const created = await service.createOrUpdateAgent({
      id: "qa-specialist",
      name: "QA Specialist",
      description: "Validates behavior and edge cases",
      systemPrompt: "You are a strict QA sub-agent.",
      provider: "openai",
      model: "gpt-5-mini",
    });
    expect(created.id).toBe("qa-specialist");

    const updated = await service.createOrUpdateAgent({
      id: "qa-specialist",
      name: "QA Specialist",
      description: "Checks regressions",
      systemPrompt: "You are a strict QA sub-agent.",
    });
    expect(updated.description).toBe("Checks regressions");
  });

  test("delegates task via jobs runtime", async () => {
    const service = new SubAgentService();
    await service.initialize();

    const jobsService = getJobsService();
    const baseJob: JobRecord = {
      id: "job-subagent-1",
      name: "Delegation: Research Specialist",
      type: "subagent",
      status: "pending",
      appIds: [STANDALONE_APP_ID],
      command: "Audit retry behavior and summarize improvements.",
      subAgentId: "research-specialist",
      delegatedBy: "main-agent",
      delegationTask: "Audit retry behavior and summarize improvements.",
      delegationContext: undefined,
      outputMode: "natural",
      outputSchema: undefined,
      maxTurns: 12,
      memoryPolicy: "summary",
      reportChatId: undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      retries: { maxAttempts: 1, backoffMs: 1000 },
      retentionDays: 14,
    };
    const createSpy = vi.spyOn(jobsService, "createJob").mockResolvedValue(baseJob);
    const runSpy = vi.spyOn(jobsService, "runJob").mockResolvedValue({
      ...baseJob,
      status: "completed",
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    const run = await service.delegateTask({
      task: "Audit retry behavior and summarize improvements.",
      useAgentId: "research-specialist",
      background: false,
    });

    expect(run.status).toBe("completed");
    expect(run.id).toBe("job-subagent-1");
    expect(runSpy).toHaveBeenCalledOnce();

    createSpy.mockRestore();
    runSpy.mockRestore();
  });

  test("migrates legacy run records into job records", async () => {
    const legacyPath = path.join(home, "Papr", "data", "subagent-runs.json");
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      JSON.stringify(
        [
          {
            id: "legacy-run-1",
            agentId: "research-specialist",
            task: "Summarize issue trends",
            status: "completed",
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          },
        ],
        null,
        2,
      ),
      "utf8",
    );

    const service = new SubAgentService();
    await service.initialize();
    const jobsService = getJobsService();
    await jobsService.initialize();
    const migrated = await jobsService.getJob("legacy-legacy-run-1");
    expect(migrated).not.toBeNull();
    expect(migrated?.type).toBe("subagent");
  });
});
