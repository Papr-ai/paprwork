/**
 * ChatGPT WebSocket Handlers
 * Handle ChatGPT conversation fetching via backend-api
 */

import type { WebSocket } from "ws";
import { sendResponse, sendError, type WSMessage } from "./index.js";
import { ChatGPTConversationsService } from "../services/ChatGPTConversationsService.js";
import { getProviderAuth } from "../utils/keyResolver.js";

const service = new ChatGPTConversationsService();

export async function setupChatGPTHandlers(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  const { id, type, payload } = message;

  try {
    switch (type) {
      case "chatgpt:list-conversations": {
        const {
          limit,
          offset,
          order,
          isArchived,
          isStarred,
        } = payload as {
          limit?: number;
          offset?: number;
          order?: "created" | "updated";
          isArchived?: boolean;
          isStarred?: boolean;
        };

        // Get OAuth token using keyResolver (same way AgentService does)
        const auth = await getProviderAuth("openai");
        if (!auth || auth.type !== "oauth") {
          throw new Error(
            "OpenAI OAuth token not found. Please connect your ChatGPT account in Settings.",
          );
        }

        console.log(
          `[ChatGPT WS] Fetching conversations (limit=${limit}, offset=${offset})`,
        );

        const conversations = await service.listConversations(auth.token, {
          limit,
          offset,
          order,
          isArchived,
          isStarred,
        });

        sendResponse(ws, {
          id,
          success: true,
          data: conversations,
        });
        break;
      }

      case "chatgpt:get-conversation": {
        const { conversationId } = payload as { conversationId: string };

        const auth = await getProviderAuth("openai");
        if (!auth || auth.type !== "oauth") {
          throw new Error("OpenAI OAuth token not found");
        }

        console.log(
          `[ChatGPT WS] Fetching conversation: ${conversationId}`,
        );

        const conversation = await service.getConversation(
          auth.token,
          conversationId,
        );

        sendResponse(ws, {
          id,
          success: true,
          data: conversation,
        });
        break;
      }

      default:
        throw new Error(`Unknown ChatGPT handler: ${type}`);
    }
  } catch (error) {
    console.error(`[ChatGPT WS] Error handling ${type}:`, error);
    sendError(ws, id, error as Error);
  }
}
