/**
 * Papr Cloud billing / subscription WebSocket handlers.
 */

import type { WebSocket } from "ws";
import type { WSMessage } from "./index.js";
import { sendResponse, sendError } from "./index.js";
import { schedulePaprCloudResumeAfterBillingRestore } from "../services/paprCloudBillingRestore.js";

export async function setupPaprHandlers(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  try {
    switch (message.type) {
      case "papr:resume-cloud": {
        const result = schedulePaprCloudResumeAfterBillingRestore();
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: result,
        });
        break;
      }

      default:
        sendError(ws, message.id, `Unknown papr message type: ${message.type}`);
    }
  } catch (error) {
    sendError(ws, message.id, error as Error);
  }
}
