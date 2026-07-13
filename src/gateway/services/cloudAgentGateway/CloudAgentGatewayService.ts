import { getAgentService } from "../AgentService.js";
import {
  beginCloudAgentRun,
  cloudAgentStreamInput,
  withCloudAgentRunContext,
} from "./cloudAgentRunContext.js";
import type { CloudAgentRunRequest, CloudAgentRunResponse } from "./types.js";
import { randomUUID } from "crypto";

export class CloudAgentGatewayService {
  async runAgentJob(request: CloudAgentRunRequest): Promise<CloudAgentRunResponse> {
    try {
      const result = await withCloudAgentRunContext(request, async () => {
        const agentService = getAgentService();
        return agentService.runIsolatedJobSession(cloudAgentStreamInput(request));
      });

      return {
        exitCode: result.text.trim() ? 0 : 1,
        output: result.text,
        chatId: result.chatId,
      };
    } catch (error) {
      return {
        exitCode: 1,
        output: "",
        error: (error as Error).message,
        chatId: `job:${request.jobId}:${request.runId}`,
      };
    }
  }

  async *streamAgentJobEvents(
    request: CloudAgentRunRequest,
  ): AsyncGenerator<Record<string, unknown>> {
    const chatId = `job:${request.jobId}:${request.runId}`;
    let handle: Awaited<ReturnType<typeof beginCloudAgentRun>> | undefined;

    yield {
      type: "session-meta",
      chatId,
      provider: request.llmAuth.provider,
      runtime: "cloud-agent-gateway",
    };

    let exitCode = 0;

    try {
      handle = await beginCloudAgentRun(request);
      const agentService = getAgentService();

      for await (const chunk of agentService.streamIsolatedJobSessionForCloud(
        cloudAgentStreamInput(request),
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
    } catch (error) {
      exitCode = 1;
      yield { type: "error", message: (error as Error).message, chatId };
    } finally {
      if (handle) {
        await handle.finish();
      }
    }

    yield { type: "done", exitCode, chatId };
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
