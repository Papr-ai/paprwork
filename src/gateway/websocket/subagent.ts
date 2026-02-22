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

interface SendMessagePayload {
  delegationId: string;
  message: string;
  author: "main-agent" | "user";
}

interface JoinChatPayload {
  delegationId: string;
}

interface GetMessagesPayload {
  delegationId: string;
  limit?: number;
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

      // ===== Mini-Chat Communication Handlers =====

      case "subagent:send-message": {
        const payload = message.payload as SendMessagePayload;
        const author = payload.author ?? "main-agent";
        await service.respondToSubAgent(
          payload.delegationId,
          payload.message,
          author,
        );
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: { delegationId: payload.delegationId, sent: true },
        });
        break;
      }

      case "subagent:join-chat": {
        const payload = message.payload as JoinChatPayload;
        // TODO: Track user as participant in sub-agent chat
        const { broadcast } = await import("./index.js");
        broadcast({
          type: "subagent-chat:user-joined",
          data: {
            delegationId: payload.delegationId,
            userId: "user", // TODO: Get actual user ID
            timestamp: new Date().toISOString(),
          },
        });
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: { delegationId: payload.delegationId, joined: true },
        });
        break;
      }

      case "subagent:get-messages": {
        const payload = message.payload as GetMessagesPayload;
        const stored = await service.loadDelegationChatMessages(
          payload.delegationId,
          payload.limit ?? 50,
        );
        const messages = stored.map((m) => ({
          role: m.role as "user" | "assistant",
          author:
            m.role === "assistant"
              ? ("sub-agent" as const)
              : m.source_agent_id === "main-agent"
                ? ("main-agent" as const)
                : ("user" as const),
          content: m.content,
          timestamp: m.timestamp,
        }));
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: { messages, delegationId: payload.delegationId },
        });
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
