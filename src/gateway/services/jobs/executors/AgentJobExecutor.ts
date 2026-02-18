import type { ExecutorLaunchParams, ExecutorLaunchResult, IJobExecutor } from "./IJobExecutor.js";
import type { JobType } from "../types.js";
import { getAgentService } from "../../AgentService.js";
import { getJobsService } from "../../JobsService.js";
import { v4 as uuidv4 } from "uuid";
import { writeRunMemory } from "../../PaprMemoryWritebackService.js";

export class AgentJobExecutor implements IJobExecutor {
  canExecute(type: JobType): boolean {
    return type === "agent" || type === "subagent";
  }

  async launch(params: ExecutorLaunchParams): Promise<ExecutorLaunchResult> {
    if (params.job.type !== "agent" && params.job.type !== "subagent") {
      throw new Error("AgentJobExecutor can only execute agent/subagent jobs");
    }

    const agentService = getAgentService();
    let prompt =
      params.job.command?.trim() ||
      `Execute agent job "${params.job.name}" and return key outcomes.`;

    let provider: "anthropic" | "openai" | "google" | undefined;
    let model: string | undefined;
    let allowedToolIds: string[] | undefined;
    let sourceAgentId = "main-agent";
    let sourceAgentName = "Main Agent";

    // ── Resolve sub-agent profile ─────────────────────────────────────────────
    let subAgentSystemPrompt: string | undefined;
    let subAgentName: string | undefined;

    if (params.job.type === "subagent") {
      if (!params.job.subAgentId) {
        throw new Error(`Sub-agent job ${params.job.id} is missing subAgentId`);
      }
      const { getSubAgentService } = await import("../../SubAgentService.js");
      const subAgentService = getSubAgentService();
      const profile = await subAgentService.getAgent(params.job.subAgentId);
      if (!profile) {
        throw new Error(`Sub-agent not found: ${params.job.subAgentId}`);
      }
      sourceAgentId = profile.id;
      sourceAgentName = profile.name;
      provider = profile.provider;
      model = profile.model;
      allowedToolIds = profile.allowedToolIds;
      subAgentName = profile.name;
      subAgentSystemPrompt = profile.systemPrompt;
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Auto-inject environment paths (own + dependencies) ───────────────────
    const envBlock = await this.buildEnvironmentBlock(params);
    // ─────────────────────────────────────────────────────────────────────────

    // ── Build final prompt ────────────────────────────────────────────────────
    if (params.job.type === "subagent") {
      prompt = [
        `[Sub-Agent: ${subAgentName!}]`,
        subAgentSystemPrompt!,
        envBlock,
        params.job.delegationContext
          ? `\nContext:\n${params.job.delegationContext}`
          : "",
        `\nTask:\n${params.job.delegationTask ?? prompt}`,
      ].filter(Boolean).join("\n");
    } else {
      prompt = [envBlock, prompt].filter(Boolean).join("\n");
    }
    // ─────────────────────────────────────────────────────────────────────────

    await params.appendLog(`Starting isolated agent run: ${params.runId}`);
    await params.appendLog(`Environment: ${envBlock}`);

    // ── Choose execution path: structured (generateObject) vs free-form (streamText)
    let outputText: string;

    if (params.job.outputMode === "structured" && params.job.outputSchema) {
      // ✅ Proper structured output via AI SDK generateObject
      // The model is constrained at the decoding level to produce valid JSON
      // matching the schema — no prompt hacks, no post-hoc parsing needed.
      await params.appendLog("Using generateObject for structured output (model-level schema enforcement)");

      const structuredResult = await agentService.runStructuredJobSession({
        jobId: params.job.id,
        runId: params.runId,
        prompt,
        outputSchema: params.job.outputSchema,
        schemaName: params.job.name.replace(/[^a-zA-Z0-9_-]/g, "_"),
        schemaDescription: `Structured output for job: ${params.job.name}`,
        provider,
        model,
      });

      outputText = JSON.stringify(structuredResult.object, null, 2);
      await params.appendLog("Structured output generated and validated by model.");
    } else {
      // Free-form text output via streamText (existing path)
      const response = await agentService.runIsolatedJobSession({
        jobId: params.job.id,
        runId: params.runId,
        prompt,
        provider,
        model,
        allowedToolIds,
        maxTurns: params.job.maxTurns,
      });
      outputText = response.text;
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (params.job.deliver?.channel === "chat") {
      await agentService.getStorageManager().saveMessage(params.job.deliver.targetId, {
        id: `msg-${uuidv4()}`,
        chat_id: params.job.deliver.targetId,
        role: "assistant",
        content:
          outputText.length > 0
            ? outputText
            : `Agent job ${params.job.name} finished with no textual output.`,
        timestamp: new Date().toISOString(),
        sync_status: "local",
      });
      await params.appendLog(
        `Delivered result to chat: ${params.job.deliver.targetId}`,
      );
    }

    await writeRunMemory({
      content: outputText,
      policy: params.job.memoryPolicy ?? "none",
      sourceAgentId,
      sourceAgentName,
      runId: params.runId,
      jobId: params.job.id,
      chatId: params.job.reportChatId ?? params.job.deliver?.targetId,
    });

    const output =
      outputText.length > 0
        ? outputText.slice(0, 5000)
        : "Agent job completed successfully.";

    return {
      mode: "immediate",
      command: `agent:${params.runId}`,
      exitCode: 0,
      outputMessage: output,
    };
  }

  /**
   * Build the environment block that tells agents where their own data
   * and dependency data lives. Solves the "cross-job file access" problem.
   */
  private async buildEnvironmentBlock(params: ExecutorLaunchParams): Promise<string> {
    const jobsService = getJobsService();
    await jobsService.initialize();

    const envLines: string[] = [];

    const ownDbPath = await jobsService.getJobDatabasePath(params.job.id);
    envLines.push(`JOB_DIR="${params.jobDir}"`);
    if (ownDbPath) envLines.push(`JOB_DB="${ownDbPath}"`);

    for (const dep of params.job.dependsOn ?? []) {
      const depJob = await jobsService.getJob(dep.jobId);
      const depDir = await jobsService.getJobPath(dep.jobId);
      const depDb  = await jobsService.getJobDatabasePath(dep.jobId);
      if (depJob && depDir) {
        const key = depJob.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
        envLines.push(`DEP_${key}_DIR="${depDir}"`);
        if (depDb) envLines.push(`DEP_${key}_DB="${depDb}"`);
      }
    }

    return envLines.length > 0
      ? `\n=== JOB ENVIRONMENT ===\n${envLines.join("\n")}\n=======================`
      : "";
  }
}
