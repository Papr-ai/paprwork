import { getAgentService } from "../AgentService.js";
import { getJobsService } from "../JobsService.js";
import { buildDelegationFinishedMessage } from "../SubAgentResponseTrigger.js";
import {
  CLOUD_DELEGATION_WAIT_MS,
  CLOUD_MAX_FOLLOW_UPS,
  markCloudRunAwaiting,
  waitForDelegations,
} from "./cloudRunDelegationWait.js";
import { resolveCloudAgentChatId } from "./cloudAppAgentSession.js";
import {
  beginCloudAgentRun,
  resolveCloudAgentJobStreamInput,
  withCloudAgentRunContext,
} from "./cloudAgentRunContext.js";
import { getCloudAgentSessionCache } from "./cloudAgentSessionCache.js";
import { collectAppProposalChanges } from "./appAgentProposal.js";
import type {
  CloudAgentRunRequest,
  CloudAgentRunResponse,
  CloudAgentSessionBeginResponse,
} from "./types.js";
import {
  beginCloudAgentOneShotStreamDedup,
  CloudAgentRunDuplicateInFlightError,
  getCachedCloudAgentRunResult,
  runWithCloudAgentRunDedup,
} from "./cloudAgentRunDedup.js";

export class CloudAgentGatewayService {
  async beginAgentSession(
    request: CloudAgentRunRequest,
  ): Promise<CloudAgentSessionBeginResponse> {
    return getCloudAgentSessionCache().beginSession(request);
  }

  async endAgentSession(sessionId: string): Promise<void> {
    await getCloudAgentSessionCache().endSession(sessionId);
  }

  async runAgentJob(request: CloudAgentRunRequest): Promise<CloudAgentRunResponse> {
    return runWithCloudAgentRunDedup(request, () => this.executeRunAgentJob(request));
  }

  private async executeRunAgentJob(
    request: CloudAgentRunRequest,
  ): Promise<CloudAgentRunResponse> {
    const chatId = resolveCloudAgentChatId(request);
    try {
      const result = await withCloudAgentRunContext(request, async () => {
        const agentService = getAgentService();
        const streamInput = await resolveCloudAgentJobStreamInput(request);
        const { session: _session, appendLog, ...jobSession } = streamInput;
        return agentService.runIsolatedJobSession({ ...jobSession, appendLog });
      });

      return {
        exitCode: 0,
        output: result.text,
        chatId: result.chatId,
      };
    } catch (error) {
      const message = (error as Error).message;
      console.error(`[CloudAgentGateway] Job ${request.jobId} failed: ${message}`);
      return {
        exitCode: 1,
        output: "",
        error: message,
        chatId,
      };
    }
  }

  async *streamAgentJobEvents(
    request: CloudAgentRunRequest,
  ): AsyncGenerator<Record<string, unknown>> {
    const warmSession = Boolean(
      request.workspaceSessionId && request.keepWorkspaceWarm,
    );

    if (warmSession && request.workspaceSessionId) {
      yield* this.streamWithWarmSession(request);
      return;
    }

    yield* this.streamOneShotRun(request);
  }

  private async *streamOneShotRun(
    request: CloudAgentRunRequest,
  ): AsyncGenerator<Record<string, unknown>> {
    const cached = getCachedCloudAgentRunResult(request);
    if (cached) {
      console.warn(
        `[CloudAgentGateway] Duplicate one-shot stream (cached) job=${request.jobId} chatId=${cached.chatId}`,
      );
      yield {
        type: "session-meta",
        chatId: cached.chatId,
        provider: request.llmAuth.provider,
        runtime: "cloud-agent-gateway",
      };
      yield { type: "done", exitCode: cached.exitCode, chatId: cached.chatId, deduplicated: true };
      return;
    }

    const chatId = resolveCloudAgentChatId(request);

    let streamDedup: ReturnType<typeof beginCloudAgentOneShotStreamDedup> | undefined;
    try {
      streamDedup = beginCloudAgentOneShotStreamDedup(request);
    } catch (error) {
      if (error instanceof CloudAgentRunDuplicateInFlightError) {
        console.warn(
          `[CloudAgentGateway] Duplicate one-shot stream job=${request.jobId} runId=${request.runId}`,
        );
        yield {
          type: "error",
          code: error.code,
          message: error.message,
          chatId,
        };
        yield { type: "done", exitCode: 0, chatId, deduplicated: true };
        return;
      }
      throw error;
    }

    yield {
      type: "session-meta",
      chatId,
      provider: request.llmAuth.provider,
      runtime: "cloud-agent-gateway",
    };

    let exitCode = 0;
    let syncError: string | undefined;
    let handle: Awaited<ReturnType<typeof beginCloudAgentRun>> | undefined;

    try {
      handle = await beginCloudAgentRun(request);
      exitCode = yield* this.yieldAgentStreamChunks(request);
      yield* this.yieldAppProposal(request, handle.paprHome);
    } catch (error) {
      exitCode = 1;
      yield { type: "error", message: (error as Error).message, chatId };
    } finally {
      if (handle) {
        try {
          await handle.finish();
        } catch (error) {
          exitCode = 1;
          syncError = (error as Error).message;
        }
      }
      streamDedup?.release({
        exitCode,
        output: "",
        chatId,
        ...(syncError ? { error: syncError } : {}),
      });
    }

    if (syncError) {
      // phase lets the caller (iMessage, agent runs) tell the user the answer
      // stands but the live app/database didn't get the changes.
      yield { type: "error", phase: "publish", message: syncError, chatId };
    }

    yield { type: "done", exitCode, chatId };
  }

  private async *streamWithWarmSession(
    request: CloudAgentRunRequest,
  ): AsyncGenerator<Record<string, unknown>> {
    const sessionId = request.workspaceSessionId as string;
    const cache = getCloudAgentSessionCache();
    const chatId = resolveCloudAgentChatId(request);

    yield {
      type: "session-meta",
      chatId,
      provider: request.llmAuth.provider,
      runtime: "cloud-agent-gateway",
      workspaceSessionId: sessionId,
    };

    const releaseTurn = await cache.acquireTurnLock(sessionId);
    let exitCode = 0;
    let syncError: string | undefined;
    let handle: Awaited<ReturnType<typeof cache.acquireForTurn>> | undefined;

    try {
      handle = await cache.acquireForTurn(request);
      exitCode = yield* this.yieldAgentStreamChunks(request);
      yield* this.yieldAppProposal(request, handle.paprHome);
    } catch (error) {
      exitCode = 1;
      yield { type: "error", message: (error as Error).message, chatId };
    } finally {
      if (handle) {
        try {
          await handle.finish({ deleteWorkspace: false });
        } catch (error) {
          exitCode = 1;
          syncError = (error as Error).message;
        }
      }
      releaseTurn();
    }

    if (syncError) {
      // phase lets the caller (iMessage, agent runs) tell the user the answer
      // stands but the live app/database didn't get the changes.
      yield { type: "error", phase: "publish", message: syncError, chatId };
    }

    yield { type: "done", exitCode, chatId };
  }

  /**
   * Contributor run: hand the turn's cumulative app edits to memory, which
   * turns them into a proposal (memory strips this event before the browser).
   */
  private async *yieldAppProposal(
    request: CloudAgentRunRequest,
    paprHome: string,
  ): AsyncGenerator<Record<string, unknown>> {
    if (request.appCodePush !== "proposal" || !request.appId) return;
    try {
      const changes = await collectAppProposalChanges(paprHome, request.appId);
      if (changes) yield { type: "app-code-proposal", ...changes };
    } catch (error) {
      console.warn("[CloudAgentGateway] proposal diff failed:", (error as Error).message);
    }
  }

  private async *yieldAgentStreamChunks(
    request: CloudAgentRunRequest,
  ): AsyncGenerator<Record<string, unknown>, number> {
    let exitCode = 0;
    const agentService = getAgentService();
    const streamInput = await resolveCloudAgentJobStreamInput(request);
    const {
      session: _session,
      appendLog,
      prompt: _prompt,
      streamUserMessage,
      chatId,
      systemPromptOverride,
      ...jobSession
    } = streamInput;

    const jobs = getJobsService();
    const helperIds = async () =>
      new Set(
        (await jobs.listJobs())
          .filter((j) => j.type === "subagent" && j.reportChatId === chatId)
          .map((j) => j.id),
      );
    let prompt = streamInput.prompt;
    let userMessage = streamUserMessage;
    // Helpers this run starts report back here; the run continues with them instead of
    // ending on "still waiting" (see cloudRunDelegationWait.ts).
    markCloudRunAwaiting(chatId, true);
    try {
      for (let followUps = 0; ; followUps++) {
        const before = await helperIds();
        for await (const chunk of agentService.streamIsolatedJobSessionForCloud({
          ...jobSession,
          prompt,
          chatId,
          userMessage,
          ...(systemPromptOverride ? { systemPromptOverride } : {}),
          appendLog,
        })) {
          if (chunk.type === "error") {
            exitCode = 1;
          }
          yield {
            type: chunk.type,
            payload: chunk.payload,
            timestamp: chunk.timestamp,
            chatId: chunk.chatId,
          };
        }
        if (exitCode !== 0 || followUps >= CLOUD_MAX_FOLLOW_UPS) break;
        const started = [...(await helperIds())].filter((id) => !before.has(id));
        if (!started.length) break;
        await appendLog(`Waiting for ${started.length} helper(s) before replying`);
        const finished = await waitForDelegations(started, (id) => jobs.getJob(id), {
          timeoutMs: CLOUD_DELEGATION_WAIT_MS,
        });
        if (!finished.length) break;
        const parts: string[] = [];
        for (const f of finished) {
          const job = await jobs.getJob(f.id);
          if (job) parts.push(await buildDelegationFinishedMessage(f.id, f.outcome, job));
        }
        if (!parts.length) break;
        prompt = userMessage = parts.join("\n\n---\n\n");
      }
    } finally {
      markCloudRunAwaiting(chatId, false);
    }

    return exitCode;
  }
}

let sharedService: CloudAgentGatewayService | undefined;

export function getCloudAgentGatewayService(): CloudAgentGatewayService {
  if (!sharedService) {
    sharedService = new CloudAgentGatewayService();
  }
  return sharedService;
}

export { newCloudAgentRunId } from "./cloudAgentRunId.js";
