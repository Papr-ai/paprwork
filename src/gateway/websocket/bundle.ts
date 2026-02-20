import type { WebSocket } from "ws";
import type { WSMessage } from "./index.js";
import { sendError, sendResponse } from "./index.js";
import {
  getBundleService,
  type ExportBundleInput,
  type ImportBundleInput,
} from "../services/BundleService.js";

export async function setupBundleHandlers(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  const bundleService = getBundleService();
  try {
    switch (message.type) {
      case "bundle:list": {
        const bundles = await bundleService.listBundles();
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: bundles,
        });
        break;
      }
      case "bundle:export": {
        const payload = message.payload as ExportBundleInput;
        const manifest = await bundleService.exportBundle(payload);
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: manifest,
        });
        break;
      }
      case "bundle:import": {
        const payload = message.payload as ImportBundleInput;
        const manifest = await bundleService.importBundle(payload);
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: manifest,
        });
        break;
      }
      default:
        sendError(
          ws,
          message.id,
          `Unknown bundle message type: ${message.type}`,
        );
    }
  } catch (error) {
    console.error("[Bundle WebSocket] Error:", error);
    sendError(ws, message.id, error as Error);
  }
}
