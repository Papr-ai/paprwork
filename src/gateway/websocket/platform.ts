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

        // This opens the login URL in the user's default browser
        // Returns immediately with waitingForConfirmation: true
        const result = await sessionService.connect(payload.platformId);
        
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: {
            ...result,
            message:
              result.status === "connected"
                ? `Connected to ${config.name}`
                : result.waitingForConfirmation
                  ? `Checking Chrome for ${config.name}. If needed, log in there — we'll detect it automatically.`
                  : result.error || `Connecting to ${config.name}`,
          },
        });
        break;
      }

      case "platform:confirm-login": {
        // Manual "Check now" while waiting for Chrome login
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

        // Extract cookies from Chrome and store them
        const result = await sessionService.confirmLogin(payload.platformId);
        
        sendResponse(ws, {
          id: message.id,
          success: result.status === "connected",
          error: result.status === "connected" ? undefined : result.error,
          data: result,
        });

        // Broadcast the result to all connected clients
        const { broadcast } = await import("./index.js");
        broadcast({
          type: "platform:status-changed",
          data: result,
        });
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
