/**
 * Chat WebSocket Handlers
 *
 * Replaces chat IPC handlers with WebSocket messages
 */

import type { WebSocket } from "ws";
import type { WSMessage } from "./index.js";
import { sendResponse, sendError } from "./index.js";
import { getAgentService } from "../services/AgentService.js";

interface CreateChatPayload {
  chatId?: string;
  title?: string;
}

interface GetChatPayload {
  chatId: string;
}

interface UpdateChatPayload {
  chatId: string;
  title: string;
}

interface DeleteChatPayload {
  chatId: string;
}

interface GetMessagesPayload {
  chatId: string;
  limit?: number;
  skip?: number;
}

interface GetStatsPayload {
  chatId: string;
}

/**
 * Setup chat WebSocket handlers
 * Routes operations to ChatService (legacy metadata) and AgentService (storage)
 */
export async function setupChatHandlers(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  const agentService = getAgentService();

  try {
    switch (message.type) {
      case "chat:list": {
        // Get chats from storage manager
        const chats = await agentService.listChats();

        // Transform snake_case to camelCase for UI
        const transformedChats = chats.map((chat) => ({
          id: chat.id,
          title: chat.title,
          createdAt: chat.created_at,
          updatedAt: chat.updated_at,
          messageCount: chat.message_count,
        }));

        sendResponse(ws, {
          id: message.id,
          success: true,
          data: transformedChats,
        });
        break;
      }

      case "chat:create": {
        const { chatId, title } = (message.payload as CreateChatPayload) || {};
        const newChatId = await agentService.createChat(chatId, title);

        const { getGatewayTelemetry } = await import("../services/gatewayTelemetry.js");
        getGatewayTelemetry().trackFireAndForget("paprwork_chat_created", {
          chat_id: newChatId,
        });

        sendResponse(ws, {
          id: message.id,
          success: true,
          data: { chatId: newChatId, title: title || "New Chat" },
        });
        break;
      }

      case "chat:get": {
        const { chatId } = message.payload as GetChatPayload;
        const chat = await agentService.getStorageManager().getChat(chatId);

        if (!chat) {
          sendError(ws, message.id, `Chat not found: ${chatId}`);
          return;
        }

        sendResponse(ws, {
          id: message.id,
          success: true,
          data: chat,
        });
        break;
      }

      case "chat:update": {
        const { chatId, title } = message.payload as UpdateChatPayload;
        await agentService.updateChatTitle(chatId, title);

        const { getGatewayTelemetry } = await import("../services/gatewayTelemetry.js");
        getGatewayTelemetry().trackFireAndForget("paprwork_chat_renamed", {
          chat_id: chatId,
        });

        sendResponse(ws, {
          id: message.id,
          success: true,
          data: { chatId, title },
        });
        break;
      }

      case "chat:delete": {
        const { chatId } = message.payload as DeleteChatPayload;
        await agentService.deleteChat(chatId);

        const { getGatewayTelemetry } = await import("../services/gatewayTelemetry.js");
        getGatewayTelemetry().trackFireAndForget("paprwork_chat_deleted", {
          chat_id: chatId,
        });

        sendResponse(ws, {
          id: message.id,
          success: true,
        });
        break;
      }

      case "chat:messages": {
        const { chatId, limit, skip } = message.payload as GetMessagesPayload;
        const messages = await agentService.getChatHistory(chatId);

        // Apply limit/skip if provided
        let result = messages;
        if (skip) {
          result = result.slice(skip);
        }
        if (limit) {
          result = result.slice(0, limit);
        }

        sendResponse(ws, {
          id: message.id,
          success: true,
          data: { messages: result, total: messages.length },
        });
        break;
      }

      case "chat:stats": {
        const { chatId } = message.payload as GetStatsPayload;
        const stats = await agentService.getChatStats(chatId);

        sendResponse(ws, {
          id: message.id,
          success: true,
          data: stats,
        });
        break;
      }

      case "chat:inspect-context": {
        const { chatId, model } = message.payload as {
          chatId: string;
          model: string;
        };
        const contextInfo = await agentService.inspectContext(chatId, model);

        sendResponse(ws, {
          id: message.id,
          success: true,
          data: contextInfo,
        });
        break;
      }

      case "chat:export": {
        const { chatId, format } = message.payload as {
          chatId: string;
          format?: "json" | "markdown";
        };
        const chat = await agentService.getStorageManager().getChat(chatId);
        const messages = await agentService.getChatHistory(chatId);
        const title = chat?.title || "Untitled Chat";
        const exportedAt = new Date().toISOString();

        if (format === "markdown") {
          const lines: string[] = [
            `# ${title}`,
            "",
            `> Exported ${new Date(exportedAt).toLocaleString()}`,
            "",
          ];
          for (const msg of messages) {
            const role = (msg as unknown as Record<string, unknown>)
              .role as string;
            const content = (msg as unknown as Record<string, unknown>)
              .content as string;
            if (role && content) {
              lines.push(
                `## ${role === "user" ? "User" : "Assistant"}`,
                "",
                content,
                "",
              );
            }
          }
          sendResponse(ws, {
            id: message.id,
            success: true,
            data: {
              content: lines.join("\n"),
              filename: `${title}.md`,
              mimeType: "text/markdown",
            },
          });
        } else {
          sendResponse(ws, {
            id: message.id,
            success: true,
            data: {
              content: JSON.stringify(
                { chatId, title, exportedAt, messages },
                null,
                2,
              ),
              filename: `${title}.json`,
              mimeType: "application/json",
            },
          });
        }
        break;
      }

      case "chat:switch": {
        // Just acknowledge - switching is handled on client side
        sendResponse(ws, {
          id: message.id,
          success: true,
        });
        break;
      }

      default:
        sendError(ws, message.id, `Unknown chat message type: ${message.type}`);
    }
  } catch (error) {
    console.error("[Chat WebSocket] Error:", error);
    sendError(ws, message.id, error as Error);
  }
}
