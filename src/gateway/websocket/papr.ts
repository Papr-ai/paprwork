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

      case "papr:entitlements": {
        // Premium models on Papr credits: paid plan + pay as you go? Fails open.
        const { getPaprApiKey } = await import("../utils/keyResolver.js");
        const key = await getPaprApiKey();
        if (!key) {
          sendResponse(ws, { id: message.id, success: true, data: { premium: true, reason: "no_key" } });
          break;
        }
        const { getPaprEntitlements } = await import("../utils/paprEntitlements.js");
        sendResponse(ws, { id: message.id, success: true, data: await getPaprEntitlements(key) });
        break;
      }

      default:
        sendError(ws, message.id, `Unknown papr message type: ${message.type}`);
    }
  } catch (error) {
    sendError(ws, message.id, error as Error);
  }
}
