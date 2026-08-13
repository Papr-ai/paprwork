/**
 * Platform WebSocket Handlers
 *
 * Handles WebSocket messages for Connected Platforms feature.
 * Delegates to PlatformSessionService for actual operations.
 */

import type { WebSocket } from "ws";
import type { WSMessage } from "./index.js";
import { sendResponse, sendError } from "./index.js";
import {
  getPlatformSessionService,
  type PlatformSessionState,
} from "../services/platforms/PlatformSessionService.js";
import {
  getSessionKeeperService,
} from "../services/platforms/SessionKeeperService.js";
import {
  type PlatformId,
  getPlatformConfig,
  getAllPlatformIds,
} from "../services/platforms/platformRegistry.js";

interface PlatformConnectPayload {
  platformId: PlatformId;
}

interface PlatformStatusPayload {
  platformId?: PlatformId;
}

export interface PlatformInfo {
  id: PlatformId;
  name: string;
  notes?: string;
  status: PlatformSessionState;
}

export async function setupPlatformHandlers(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  try {
    switch (message.type) {
      case "platform:get-all": {
        // Get all platforms with their status
        const sessionService = getPlatformSessionService();
        await sessionService.initialize();

        const platforms: PlatformInfo[] = [];
        for (const platformId of getAllPlatformIds()) {
          const config = getPlatformConfig(platformId);
          if (!config) continue;

          const status = await sessionService.getStatus(platformId);
          platforms.push({
            id: platformId,
            name: config.name,
            notes: config.notes,
            status,
          });
        }

        sendResponse(ws, {
          id: message.id,
          success: true,
          data: platforms,
        });
        break;
      }

      case "platform:get-status": {
        const payload = message.payload as PlatformStatusPayload;
        const sessionService = getPlatformSessionService();
        await sessionService.initialize();

        if (payload.platformId) {
          const status = await sessionService.getStatus(payload.platformId);
          sendResponse(ws, {
            id: message.id,
            success: true,
            data: status,
          });
        } else {
          const statuses = await sessionService.getAllStatuses();
          sendResponse(ws, {
            id: message.id,
            success: true,
            data: statuses,
          });
        }
        break;
      }

      case "platform:connect": {
        const payload = message.payload as PlatformConnectPayload;
        if (!payload.platformId) {
          sendError(ws, message.id, "platformId is required");
          return;
        }

        const config = getPlatformConfig(payload.platformId);
        if (!config) {
          sendError(ws, message.id, `Unknown platform: ${payload.platformId}`);
          return;
        }

        const sessionService = getPlatformSessionService();
        await sessionService.initialize();

        // This opens a browser window for the user to log in
        // It may take a few minutes, so we send a "connecting" status first
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: {
            platformId: payload.platformId,
            status: "connecting",
            message: `Opening ${config.name} login page. Please log in to continue.`,
          },
        });

        // Actually perform the connect (this blocks until user logs in or timeout)
        try {
          const result = await sessionService.connect(payload.platformId);
          
          // Broadcast the result to all connected clients
          const { broadcast } = await import("./index.js");
          broadcast({
            type: "platform:status-changed",
            data: result,
          });
        } catch (error) {
          const { broadcast } = await import("./index.js");
          broadcast({
            type: "platform:status-changed",
            data: {
              platformId: payload.platformId,
              status: "disconnected",
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
        break;
      }

      case "platform:disconnect": {
        const payload = message.payload as PlatformConnectPayload;
        if (!payload.platformId) {
          sendError(ws, message.id, "platformId is required");
          return;
        }

        const sessionService = getPlatformSessionService();
        await sessionService.initialize();

        const result = await sessionService.disconnect(payload.platformId);
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: result,
        });
        break;
      }

      case "platform:refresh": {
        const payload = message.payload as PlatformConnectPayload;
        if (!payload.platformId) {
          sendError(ws, message.id, "platformId is required");
          return;
        }

        const sessionKeeper = getSessionKeeperService();
        const result = await sessionKeeper.forceRefresh(payload.platformId);
        
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: result,
        });
        break;
      }

      default:
        // Not a platform message - ignore
        break;
    }
  } catch (error) {
    console.error("[Platform WebSocket] Error:", error);
    sendError(
      ws,
      message.id,
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}
