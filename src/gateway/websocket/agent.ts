/**
 * Agent WebSocket Handlers
 *
 * Replaces agent IPC handlers with WebSocket messages
 */

import type { WebSocket } from "ws";
import type { WSMessage } from "./index.js";
import { sendResponse, sendError } from "./index.js";
import { getAgentService } from "../services/AgentService.js";
import type { AgentConfig } from "../../core/types/agents.js";

interface StreamPayload {
  chatId: string;
  message: string;
  config: AgentConfig;
}

interface StopStreamingPayload {
  chatId: string;
}

interface ChatHistoryPayload {
  chatId: string;
}

interface GenerateTitlePayload {
  chatId: string;
  message: string;
}

/**
 * Setup agent WebSocket handlers
 * Supports parallel streaming with chatId-based routing
 */
export async function setupAgentHandlers(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  const agentService = getAgentService();

  try {
    switch (message.type) {
      case "agent:stream": {
        const payload = message.payload as StreamPayload;
        const { chatId, message: userMessage, config } = payload;

        if (!chatId || !userMessage) {
          sendError(ws, message.id, "Missing chatId or message");
          return;
        }

        // Fetch API key via IPC (secure method - never sent over WebSocket)
        let apiKey: string;
        try {
          const { getApiKeys } = await import("../utils/keyResolver.js");
          const keyName = `${config.provider.toUpperCase()}_API_KEY`;
          const keys = await getApiKeys([keyName]);
          apiKey = keys[keyName];
          
          if (!apiKey) {
            sendError(ws, message.id, `API key not found: ${keyName}`);
            return;
          }
        } catch (keyError) {
          console.error(`[Agent WS] Failed to fetch API key:`, keyError);
          sendError(ws, message.id, "Failed to fetch API key");
          return;
        }

        // Create internal config with API key
        const configInternal = { ...config, apiKey };

        // Stream response chunks back to client
        // Each chunk includes chatId for frontend routing
        console.log(`[Agent WS] Starting stream for chat ${chatId}`);
        let chunkCount = 0;
        
        try {
          for await (const chunk of agentService.streamAgent(chatId, userMessage, configInternal)) {
            chunkCount++;
            
            if (ws.readyState === ws.OPEN) {
              // Send chunk with chatId for parallel stream routing
              ws.send(
                JSON.stringify({
                  id: message.id,
                  type: "agent:chunk",
                  data: chunk, // chunk already includes chatId from streamAgent
                }),
              );
            } else {
              console.warn(`[Agent WS] WebSocket closed for chat ${chatId}`);
              break;
            }
          }
          
          console.log(`[Agent WS] Stream complete for chat ${chatId}. Chunks: ${chunkCount}`);

          // Send completion
          if (ws.readyState === ws.OPEN) {
            ws.send(
              JSON.stringify({
                id: message.id,
                type: "agent:complete",
                data: { chatId, done: true },
              }),
            );
          }
        } catch (streamError) {
          console.error(`[Agent WS] Stream error for chat ${chatId}:`, streamError);
          
          // Send error
          if (ws.readyState === ws.OPEN) {
            ws.send(
              JSON.stringify({
                id: message.id,
                type: "agent:error",
                data: {
                  chatId,
                  error: streamError instanceof Error ? streamError.message : 'Stream error',
                },
              }),
            );
          }
        }
        break;
      }

      case "agent:stop": {
        const { chatId } = message.payload as StopStreamingPayload;
        
        if (!chatId) {
          sendError(ws, message.id, "Missing chatId");
          return;
        }

        await agentService.stopStreaming(chatId);
        console.log(`[Agent WS] Stopped streaming for chat ${chatId}`);
        
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: { chatId },
        });
        break;
      }

      case "agent:history": {
        const { chatId } = message.payload as ChatHistoryPayload;
        const history = await agentService.getChatHistory(chatId);
        
        // StoredMessage already has correct format (role, content) - no transformation needed
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: history,
        });
        break;
      }

      case "agent:generate-title": {
        const { chatId, message: firstMessage } = message.payload as GenerateTitlePayload;
        
        if (!chatId || !firstMessage) {
          sendError(ws, message.id, "Missing chatId or message");
          return;
        }

        const title = await agentService.generateChatTitle(chatId, firstMessage);
        
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: { title },
        });
        break;
      }

      case "agent:sessions": {
        const sessions = agentService.getActiveSessions();
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: {
            sessions: sessions.map(s => ({
              chatId: s.chatId,
              isStreaming: s.isStreaming,
              model: s.config.model,
              provider: s.config.provider,
            })),
          },
        });
        break;
      }

      default:
        sendError(
          ws,
          message.id,
          `Unknown agent message type: ${message.type}`,
        );
    }
  } catch (error) {
    console.error("[Agent WebSocket] Error:", error);
    if (error instanceof Error) {
      console.error("[Agent WebSocket] Stack:", error.stack);
    }
    sendError(ws, message.id, error as Error);
  }
}
