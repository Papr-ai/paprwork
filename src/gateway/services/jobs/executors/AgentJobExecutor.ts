import type {
  ExecutorLaunchParams,
  ExecutorLaunchResult,
  IJobExecutor,
} from "./IJobExecutor.js";
import type { JobType } from "../types.js";
import { getAgentService } from "../../AgentService.js";
import { getJobsService } from "../../JobsService.js";
import { v4 as uuidv4 } from "uuid";
import { writeRunMemory } from "../../PaprMemoryWritebackService.js";
import {
  getSleepCycleService,
  isSleepCycleJobName,
} from "../../SleepCycleService.js";
import {
  getWikiWriterService,
  isWikiWriterJobName,
} from "../../WikiWriterService.js";
import type { SubAgentIconName } from "../../../../core/types/subagents.js";
import {
  jobAppDatabasePromptLines,
  resolveJobAppDatabase,
} from "../../jobAppDatabase.js";

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

    let provider:
      | "anthropic"
      | "openai"
      | "openai-codex"
      | "google"
      | "ollama"
      | "cursor"
      | "zai"
      | "groq"
      | undefined;
    let model: string | undefined;
    let allowedToolIds: string[] | undefined;
    let fallbackProvider:
      | "anthropic"
      | "openai"
      | "openai-codex"
      | "google"
      | "ollama"
      | "cursor"
      | "zai"
      | "groq"
      | undefined;
    let fallbackModel: string | undefined;
    let sourceAgentId = "main-agent";
    let sourceAgentName = "Main Agent";

    // ── Read provider/model from job record (applies to both agent and subagent jobs) ─
    if (params.job.provider) {
      provider = params.job.provider as
        | "anthropic"
        | "openai"
        | "openai-codex"
        | "google"
        | "ollama"
        | "cursor"
        | "zai"
        | "groq";
    }
    if (params.job.model) {
      model = params.job.model;
    }
    // ─────────────────────────────────────────────────────────────────────────────────

    // ── Resolve sub-agent profile (may override provider/model) ───────────────────────
    let subAgentSystemPrompt: string | undefined;
    let subAgentName: string | undefined;
    let subAgentIcon: SubAgentIconName | undefined;

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
      // Subagent profile provider/model takes precedence over job record
      if (profile.provider) provider = profile.provider;
      if (profile.model) model = profile.model;
      if (profile.fallbackProvider) fallbackProvider = profile.fallbackProvider;
      if (profile.fallbackModel) fallbackModel = profile.fallbackModel;
      allowedToolIds = profile.allowedToolIds;
      subAgentName = profile.name;
      subAgentSystemPrompt = profile.systemPrompt;
      subAgentIcon = profile.icon;
    }
    // ─────────────────────────────────────────────────────────────────────────────────

    // ── Auto-inject environment paths (own + dependencies) ───────────────────
    const envBlock = await this.buildEnvironmentBlock(params);
    // ─────────────────────────────────────────────────────────────────────────

    // ── Build final prompt ────────────────────────────────────────────────────
    if (params.job.type === "subagent") {
      const delegationIdBlock = `\n[Delegation ID: ${params.job.id}]\nWhen using request_agent_input, always pass delegationId: "${params.job.id}" so your question appears in the correct chat.`;
      prompt = [
        `[Sub-Agent: ${subAgentName!}]`,
        subAgentSystemPrompt!,
        envBlock,
        delegationIdBlock,
        params.job.delegationContext
          ? `\nContext:\n${params.job.delegationContext}`
          : "",
        `\nTask:\n${params.job.delegationTask ?? prompt}`,
      ]
        .filter(Boolean)
        .join("\n");
    } else {
      if (isSleepCycleJobName(params.job.name)) {
        const preflight = await getSleepCycleService().buildPreflightContext(
          params.job.id,
        );
        prompt = [envBlock, preflight, prompt].filter(Boolean).join("\n\n");
      } else if (isWikiWriterJobName(params.job.name)) {
        const preflight = await getWikiWriterService().buildPreflightContext(
          params.job.id,
        );
        prompt = [envBlock, preflight, prompt].filter(Boolean).join("\n\n");
      } else {
        prompt = [envBlock, prompt].filter(Boolean).join("\n");
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    await params.appendLog(`Starting isolated agent run: ${params.runId}`);
    await params.appendLog(`Environment: ${envBlock}`);

    // Set tool execution context so tools can access the reportChatId
    // This ensures nested delegations (sub-agent delegating to another sub-agent) inherit the correct chatId
    if (params.job.reportChatId) {
      const { setToolContext } = await import("../../../../core/tools/context.js");
      setToolContext(params.job.reportChatId);
    }

    // Broadcast subagent-job-started so UI can show MiniChatCard during run (receives activity)
    if (params.job.type === "subagent") {
      const reportChatId =
        params.job.reportChatId ?? params.job.deliver?.targetId;
      if (reportChatId) {
        const { broadcast } = await import("../../../websocket/index.js");
        broadcast({
          type: "subagent-job-started",
          data: {
            jobId: params.job.id,
            reportChatId,
            subAgentId: params.job.subAgentId,
            agentName: subAgentName,
            agentIcon: subAgentIcon,
          },
        });
      }
    }

    // ── Choose execution path: structured (generateObject) vs free-form (streamText)
    let outputText: string;
    let executionError: Error | null = null;

    try {
      if (params.job.outputMode === "structured" && params.job.outputSchema) {
        // ✅ Proper structured output via AI SDK generateObject
        // The model is constrained at the decoding level to produce valid JSON
        // matching the schema — no prompt hacks, no post-hoc parsing needed.
        await params.appendLog(
          "Using generateObject for structured output (model-level schema enforcement)",
        );

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
        await params.appendLog(
          "Structured output generated and validated by model.",
        );
      } else {
        // Free-form text output via streamText (existing path)
        const response = await agentService.runIsolatedJobSession({
          jobId: params.job.id,
          runId: params.runId,
          prompt,
          provider,
          model,
          fallbackProvider,
          fallbackModel,
          allowedToolIds,
          maxTurns: params.job.maxTurns,
          appendLog: params.appendLog,
          delegationId:
            params.job.type === "subagent" ? params.job.id : undefined,
        });
        outputText = response.text;
      }
    } catch (error) {
      executionError = error instanceof Error ? error : new Error(String(error));
      outputText = "";
      await params.appendLog(
        `Agent execution failed: ${executionError.message}`,
      );
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (params.job.deliver?.channel === "chat") {
      const deliveryMessage = {
        id: `msg-${uuidv4()}`,
        chat_id: params.job.deliver.targetId,
        role: "assistant" as const,
        content:
          outputText.length > 0
            ? outputText
            : `Agent job ${params.job.name} finished with no textual output.`,
        timestamp: new Date().toISOString(),
        sync_status: "local" as const,
      };
      await agentService
        .getStorageManager()
        .saveMessage(params.job.deliver.targetId, deliveryMessage);
      await params.appendLog(
        `Delivered result to chat: ${params.job.deliver.targetId}`,
      );

      // Broadcast to UI so the message appears immediately without needing app restart
      const { broadcast } = await import("../../../websocket/index.js");
      broadcast({
        type: "chat:message-received",
        data: {
          chatId: params.job.deliver.targetId,
          message: deliveryMessage,
        },
      });
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

    const modelInfo =
      provider && model
        ? ` (${provider}/${model})`
        : " (default openai/gpt-5-6-sol)";

    if (outputText.length === 0) {
      await params.appendLog(
        `[WARN] Agent job produced no model output${modelInfo}. ` +
          "Check: OAuth connected or API key set in Settings; see Gateway logs for API errors.",
      );
    }

    const output =
      outputText.length > 0
        ? outputText.slice(0, 5000)
        : "Agent job completed successfully.";

    // Determine exit code based on execution result
    // Agent jobs should fail (exitCode: 1) if:
    // 1. Exception was thrown during execution
    // 2. No model output was produced
    const exitCode = executionError || outputText.length === 0 ? 1 : 0;
    const errorMessage = executionError
      ? executionError.message
      : outputText.length === 0
        ? `[WARN] Agent job produced no model output${modelInfo}. ` +
          "Check: OAuth connected or API key set in Settings; see Gateway logs for API errors."
        : undefined;

    return {
      mode: "immediate",
      command: `agent:${params.runId}`,
      exitCode,
      outputMessage: output,
      errorMessage,
    };
  }

  /**
   * Build the environment block that tells agents where their own data
   * and dependency data lives. Solves the "cross-job file access" problem.
   */
  private async buildEnvironmentBlock(
    params: ExecutorLaunchParams,
  ): Promise<string> {
    const jobsService = getJobsService();
    await jobsService.initialize();

    const envLines: string[] = [];

    const ownDbPath = await jobsService.getJobDatabasePath(params.job.id);
    envLines.push(`JOB_DIR="${params.jobDir}"`);
    if (ownDbPath) envLines.push(`JOB_DB="${ownDbPath}"`);

    const appDb = await resolveJobAppDatabase(params.job.appIds);
    if (appDb) {
      envLines.push(...jobAppDatabasePromptLines(appDb));
    }

    for (const dep of params.job.dependsOn ?? []) {
      const depJob = await jobsService.getJob(dep.jobId);
      const depDir = await jobsService.getJobPath(dep.jobId);
      const depDb = await jobsService.getJobDatabasePath(dep.jobId);
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
