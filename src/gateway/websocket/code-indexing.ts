/**
 * WebSocket handlers for code indexing status
 */

import type { WebSocket } from "ws";
import type { WSMessage } from "./index.js";
import { sendResponse, sendError } from "./index.js";
import { getCodeIndexingStatus } from "../services/CodeIndexingService.js";

export async function setupCodeIndexingHandlers(
  ws: WebSocket,
  message: WSMessage
): Promise<void> {
  try {
    if (message.type === "code-indexing:status") {
      const status = getCodeIndexingStatus();
      sendResponse(ws, {
        id: message.id,
        success: true,
        data: status
      });
    } else {
      sendError(ws, message.id, `Unknown code-indexing message type: ${message.type}`);
    }
  } catch (error) {
    sendError(ws, message.id, error as Error);
  }
}
