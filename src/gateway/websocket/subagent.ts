import type { WebSocket } from "ws";
import type { WSMessage } from "./index.js";
import { sendError, sendResponse } from "./index.js";
import { getSubAgentService } from "../services/SubAgentService.js";
import type { Provider } from "../../core/types/agents.js";
import type { DelegateTaskInput } from "../../core/types/subagents.js";

interface UpsertSubAgentPayload {
  id?: string;
  name: string;
  description: string;
  systemPrompt: string;
  provider?: Provider;
  model?: string;
  allowedToolIds?: string[];
  assignedSkills?: string[];
  outputMode?: "natural" | "structured";
  outputSchema?: Record<string, unknown>;
  maxTurns?: number;
  memoryPolicy?: "none" | "summary" | "full";
}

interface DeleteSubAgentPayload {
  agentId: string;
}

interface ListRunsPayload {
  limit?: number;
}

interface GetRunPayload {
  runId: string;
}

export async function setupSubAgentHandlers(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  const service = getSubAgentService();
  try {
    switch (message.type) {
      case "subagent:list": {
        const agents = await service.listAgents();
        sendResponse(ws, { id: message.id, success: true, data: { agents } });
        break;
      }
      case "subagent:upsert": {
        const payload = message.payload as UpsertSubAgentPayload;
        const agent = await service.createOrUpdateAgent(payload);
        sendResponse(ws, { id: message.id, success: true, data: { agent } });
        break;
      }
      case "subagent:delete": {
        const payload = message.payload as DeleteSubAgentPayload;
        const deleted = await service.deleteAgent(payload.agentId);
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: { deleted, agentId: payload.agentId },
        });
        break;
      }
      case "subagent:delegate": {
        const payload = message.payload as DelegateTaskInput;
        const run = await service.delegateTask(payload);
        sendResponse(ws, { id: message.id, success: true, data: { run } });
        break;
      }
      case "subagent:runs": {
        const payload = (message.payload ?? {}) as ListRunsPayload;
        const runs = await service.listRuns(payload.limit ?? 50);
        sendResponse(ws, { id: message.id, success: true, data: { runs } });
        break;
      }
      case "subagent:dashboard": {
        const payload = (message.payload ?? {}) as { limit?: number };
        const dashboard = await service.getDashboard(payload.limit ?? 100);
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: dashboard,
        });
        break;
      }
      case "subagent:get-run": {
        const payload = message.payload as GetRunPayload;
        const run = await service.getRun(payload.runId);
        if (!run) {
          sendError(
            ws,
            message.id,
            `Delegation run not found: ${payload.runId}`,
          );
          return;
        }
        sendResponse(ws, { id: message.id, success: true, data: { run } });
        break;
      }
      default:
        sendError(
          ws,
          message.id,
          `Unknown subagent message type: ${message.type}`,
        );
    }
  } catch (error) {
    console.error("[SubAgent WebSocket] Error:", error);
    sendError(ws, message.id, error as Error);
  }
}
