import type { WebSocket } from "ws";
import type { WSMessage } from "./index.js";
import { sendError, sendResponse } from "./index.js";
import {
  getTemplateService,
  type CreatePipelineTemplateInput,
} from "../services/TemplateService.js";

export async function setupTemplateHandlers(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  const templateService = getTemplateService();

  try {
    switch (message.type) {
      case "template:create-pipeline": {
        const payload = message.payload as CreatePipelineTemplateInput;
        const result = await templateService.createPipelineTemplate(payload);
        sendResponse(ws, { id: message.id, success: true, data: result });
        break;
      }
      default:
        sendError(
          ws,
          message.id,
          `Unknown template message type: ${message.type}`,
        );
    }
  } catch (error) {
    console.error("[Template WebSocket] Error:", error);
    sendError(ws, message.id, error as Error);
  }
}
