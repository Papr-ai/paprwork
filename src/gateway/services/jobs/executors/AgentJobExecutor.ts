import type {
  ExecutorLaunchParams,
  ExecutorLaunchResult,
  IJobExecutor,
} from "./IJobExecutor.js";
import type { JobType } from "../types.js";
import type { Provider } from "../../../../core/types/agents.js";
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
  jobWriteDatabaseEnv,
  jobWriteDatabasePromptLines,
  resolveJobWriteTargets,
} from "../../jobAppDatabase.js";
import { STANDALONE_APP_ID } from "../appIds.js";
import type { IsolatedJobRunDiagnostics } from "../../AgentService.js";

export interface AgentJobSessionInput {
  jobId: string;
  runId: string;
  prompt: string;
  envBlock: string;
  provider?: Provider;
  model?: string;
  fallbackProvider?: Provider;
  fallbackModel?: string;
  allowedToolIds?: string[];
  maxTurns?: number;
  delegationId?: string;
  sourceAgentId: string;
  sourceAgentName: string;
  subAgentName?: string;
  subAgentIcon?: SubAgentIconName;
}

function describeEmptyJobOutput(diag: IsolatedJobRunDiagnostics): string {
  const modelLabel = `${diag.provider}/${diag.model}`;
  const authNote =
    diag.authType != null
      ? ` Auth succeeded (${diag.authType}).`
      : "";

  if (diag.streamError) {
    return (
      `[WARN] Agent job produced no model output (${modelLabel}): ${diag.streamError}`
    );
  }

  if (diag.orphanToolCount > 0) {
    const maxTurnsNote =
      diag.maxTurns != null
        ? ` maxTurns=${diag.maxTurns}.`
        : "";
    return (
      `[WARN] Agent job stream ended with ${diag.orphanToolCount} unfinished tool call(s) ` +
      `before the model could respond (${modelLabel}).${authNote}` +
      ` The run may have hit a step/context limit or been interrupted.${maxTurnsNote} ` +
      `See job log for tool errors (e.g. missing $APP_DB, Reddit 403).`
    );
  }

  if (diag.toolCallCount > 0) {
    return (
      `[WARN] Agent job ran ${diag.toolCallCount} tool call(s) but produced no final text (${modelLabel}).${authNote} ` +
      `The model likely stopped after tool use without a summary. Check job log for failed tools; ` +
      `increase maxTurns or add "print a final summary" to the job command.`
    );
  }

  return (
    `[WARN] Agent job produced no model output (${modelLabel}).${authNote} ` +
    `The model returned an empty response — see Gateway logs for API details.`
  );
}

export class AgentJobExecutor implements IJobExecutor {
  canExecute(type: JobType): boolean {
    return type === "agent" || type === "subagent";
  }

  /**
   * Build prompt, env block, and provider settings from job record + runtimeParams.
   * Single source of truth for desktop and cloud agent job runs.
   */
  async buildSessionInput(
    params: ExecutorLaunchParams,
  ): Promise<AgentJobSessionInput> {
    if (params.job.type !== "agent" && params.job.type !== "subagent") {
      throw new Error("AgentJobExecutor can only execute agent/subagent jobs");
    }

    let prompt =
      params.job.command?.trim() ||
      `Execute agent job "${params.job.name}" and return key outcomes.`;

    let provider: Provider | undefined;
    let model: string | undefined;
    let allowedToolIds: string[] | undefined;
    let fallbackProvider: Provider | undefined;
    let fallbackModel: string | undefined;
    let sourceAgentId = "main-agent";
    let sourceAgentName = "Main Agent";

    if (params.job.provider) {
      provider = params.job.provider as Provider;
    }
    if (params.job.model) {
      model = params.job.model;
    }

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
      if (profile.provider) provider = profile.provider;
      if (profile.model) model = profile.model;
      if (profile.fallbackProvider) fallbackProvider = profile.fallbackProvider;
      if (profile.fallbackModel) fallbackModel = profile.fallbackModel;
      allowedToolIds = profile.allowedToolIds;
      subAgentName = profile.name;
      subAgentSystemPrompt = profile.systemPrompt;
      subAgentIcon = profile.icon;
    }

    const envBlock = await this.buildEnvironmentBlock(params);

    let taskBody = params.job.delegationTask ?? prompt;
    if (params.runtimeParams?.prompt?.trim()) {
      taskBody = params.runtimeParams.prompt.trim();
    }
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
        `\nTask:\n${taskBody}`,
      ]
        .filter(Boolean)
        .join("\n");
    } else if (isSleepCycleJobName(params.job.name)) {
      const preflight = await getSleepCycleService().buildPreflightContext(
        params.job.id,
      );
      prompt = [envBlock, preflight, taskBody].filter(Boolean).join("\n\n");
    } else if (isWikiWriterJobName(params.job.name)) {
      const preflight = await getWikiWriterService().buildPreflightContext(
        params.job.id,
      );
      prompt = [envBlock, preflight, taskBody].filter(Boolean).join("\n\n");
    } else {
      prompt = [envBlock, taskBody].filter(Boolean).join("\n");
    }

    return {
      jobId: params.job.id,
      runId: params.runId,
      prompt,
      envBlock,
      provider,
      model,
      fallbackProvider,
      fallbackModel,
      allowedToolIds,
      maxTurns: params.job.maxTurns,
      delegationId: params.job.type === "subagent" ? params.job.id : undefined,
      sourceAgentId,
      sourceAgentName,
      subAgentName,
      subAgentIcon,
    };
  }

  async launch(params: ExecutorLaunchParams): Promise<ExecutorLaunchResult> {
    if (params.job.type !== "agent" && params.job.type !== "subagent") {
      throw new Error("AgentJobExecutor can only execute agent/subagent jobs");
    }

    const agentService = getAgentService();
    const session = await this.buildSessionInput(params);
    const { envBlock, subAgentName, subAgentIcon } = session;

    await params.appendLog(`Starting isolated agent run: ${params.runId}`);
    await params.appendLog(`Environment: ${envBlock}`);

    const jobChatId = `job:${params.job.id}:${params.runId}`;
    const writeTargets = await resolveJobWriteTargets(params.job);
    const linkedAppId = (params.job.appIds ?? []).find(
      (id) => id !== STANDALONE_APP_ID,
    );
    const jobDbPath = await getJobsService().getJobDatabasePath(params.job.id);
    const { getPaprRoot } = await import("../../../../core/utils/paprRoot.js");
    const jobEnv: Record<string, string> = {
      PAPR_HOME: getPaprRoot(),
      JOB_DIR: params.jobDir,
      ...(jobDbPath ? { JOB_DB: jobDbPath } : {}),
      ...(writeTargets.length > 0
        ? jobWriteDatabaseEnv(writeTargets, linkedAppId)
        : {}),
    };

    const { setToolContext } = await import("../../../../core/tools/context.js");
    setToolContext(jobChatId, {
      delegationJobId:
        params.job.type === "subagent" ? params.job.id : undefined,
      jobEnv,
    });

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
    let runDiagnostics: IsolatedJobRunDiagnostics | undefined;

    try {
      if (params.job.outputMode === "structured" && params.job.outputSchema) {
        // ✅ Proper structured output via AI SDK generateObject
        // The model is constrained at the decoding level to produce valid JSON
        // matching the schema — no prompt hacks, no post-hoc parsing needed.
        await params.appendLog(
          "Using generateObject for structured output (model-level schema enforcement)",
        );

        const structuredResult = await agentService.runStructuredJobSession({
          jobId: session.jobId,
          runId: session.runId,
          prompt: session.prompt,
          outputSchema: params.job.outputSchema,
          schemaName: params.job.name.replace(/[^a-zA-Z0-9_-]/g, "_"),
          schemaDescription: `Structured output for job: ${params.job.name}`,
          provider: session.provider,
          model: session.model,
        });

        outputText = JSON.stringify(structuredResult.object, null, 2);
        await params.appendLog(
          "Structured output generated and validated by model.",
        );
      } else {
        // Free-form text output via streamText (existing path)
        const response = await agentService.runIsolatedJobSession({
          jobId: session.jobId,
          runId: session.runId,
          prompt: session.prompt,
          provider: session.provider,
          model: session.model,
          fallbackProvider: session.fallbackProvider,
          fallbackModel: session.fallbackModel,
          allowedToolIds: session.allowedToolIds,
          maxTurns: session.maxTurns,
          appendLog: params.appendLog,
          delegationId: session.delegationId,
        });
        outputText = response.text;
        runDiagnostics = response.diagnostics;
      }
    } catch (error) {
      executionError = error instanceof Error ? error : new Error(String(error));
      outputText = "";
      await params.appendLog(
        `Agent execution failed: ${executionError.message}`,
      );
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (params.job.deliver?.channel === "chat" && params.job.type !== "subagent") {
      // Sub-agent delegations: SubAgentResponseTrigger posts the user-facing summary.
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
      sourceAgentId: session.sourceAgentId,
      sourceAgentName: session.sourceAgentName,
      runId: params.runId,
      jobId: params.job.id,
      chatId: params.job.reportChatId ?? params.job.deliver?.targetId,
    });

    const emptyOutputWarning =
      runDiagnostics != null
        ? describeEmptyJobOutput(runDiagnostics)
        : `[WARN] Agent job produced no model output. See Gateway logs for details.`;

    if (outputText.length === 0) {
      await params.appendLog(emptyOutputWarning);
    }

    const output =
      outputText.length > 0
        ? outputText
        : "Agent job completed successfully.";

    // Determine exit code based on execution result
    // Agent jobs should fail (exitCode: 1) if:
    // 1. Exception was thrown during execution
    // 2. No model output was produced
    const exitCode = executionError || outputText.length === 0 ? 1 : 0;
    const errorMessage = executionError
      ? executionError.message
      : outputText.length === 0
        ? emptyOutputWarning
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

    const { getPaprRoot } = await import("../../../../core/utils/paprRoot.js");
    envLines.push(`PAPR_HOME="${getPaprRoot()}"`);

    const ownDbPath = await jobsService.getJobDatabasePath(params.job.id);
    envLines.push(`JOB_DIR="${params.jobDir}"`);
    if (ownDbPath) envLines.push(`JOB_DB="${ownDbPath}"`);

    const writeTargets = await resolveJobWriteTargets(params.job);
    if (writeTargets.length > 0) {
      envLines.push(...jobWriteDatabasePromptLines(writeTargets));
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
