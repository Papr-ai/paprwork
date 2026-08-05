import { getAgentService } from "../AgentService.js";
import {
  beginCloudAgentRun,
  resolveCloudAgentJobStreamInput,
  withCloudAgentRunContext,
} from "./cloudAgentRunContext.js";
import { getCloudAgentSessionCache } from "./cloudAgentSessionCache.js";
import type {
  CloudAgentRunRequest,
  CloudAgentRunResponse,
  CloudAgentSessionBeginResponse,
} from "./types.js";
import { randomUUID } from "crypto";

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
    const chatId = `job:${request.jobId}:${request.runId}`;
    try {
      const result = await withCloudAgentRunContext(request, async () => {
        const agentService = getAgentService();
        const streamInput = await resolveCloudAgentJobStreamInput(request);
        const { session: _session, ...jobSession } = streamInput;
        return agentService.runIsolatedJobSession(jobSession);
      });

      const output = result.text.trim();
      return {
        exitCode: output ? 0 : 1,
        output: result.text,
        error: output ? undefined : "Agent job finished with no output",
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
    const chatId = `job:${request.jobId}:${request.runId}`;

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
    }

    if (syncError) {
      yield { type: "error", message: syncError, chatId };
    }

    yield { type: "done", exitCode, chatId };
  }

  private async *streamWithWarmSession(
    request: CloudAgentRunRequest,
  ): AsyncGenerator<Record<string, unknown>> {
    const sessionId = request.workspaceSessionId as string;
    const cache = getCloudAgentSessionCache();
    const chatId = `job:${request.jobId}:${request.runId}`;

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
      yield { type: "error", message: syncError, chatId };
    }

    yield { type: "done", exitCode, chatId };
  }

  private async *yieldAgentStreamChunks(
    request: CloudAgentRunRequest,
  ): AsyncGenerator<Record<string, unknown>, number> {
    let exitCode = 0;
    const agentService = getAgentService();
    const streamInput = await resolveCloudAgentJobStreamInput(request);
    const { session: _session, ...jobSession } = streamInput;

    for await (const chunk of agentService.streamIsolatedJobSessionForCloud(
      jobSession,
    )) {
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

export function newCloudAgentRunId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}
