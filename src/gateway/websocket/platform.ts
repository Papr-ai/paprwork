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
  getPlatformConfig,
  getAllPlatformIds,
} from "../services/platforms/platformRegistry.js";

interface PlatformConnectPayload {
  platformId: string;
}

interface PlatformStatusPayload {
  platformId?: string;
}

interface PlatformRegisterPayload {
  url: string;
  name?: string;
}

interface PlatformUnregisterPayload {
  platformId: string;
}

export interface PlatformInfo {
  id: string;
  name: string;
  notes?: string;
  status: PlatformSessionState;
  isCustom?: boolean;
  homeUrl?: string;
  registeredBy?: "user" | "agent";
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

          const status =
            platformId === "linkedin"
              ? await sessionService.getStatusWithLiveValidation(platformId)
              : await sessionService.getStatus(platformId);
          platforms.push({
            id: platformId,
            name: config.name,
            notes: config.notes,
            status,
            isCustom: config.isCustom,
            homeUrl: config.isCustom ? config.homeUrl : undefined,
            registeredBy: config.registeredBy,
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
          const status =
            payload.platformId === "linkedin"
              ? await sessionService.getStatusWithLiveValidation(payload.platformId)
              : await sessionService.getStatus(payload.platformId);
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
                ? result.chromeWindowOpened
                  ? `Connected to ${config.name}. A Chrome window opened with your session.`
                  : `Connected to ${config.name}`
                : result.waitingForConfirmation
                  ? result.externalChrome
                    ? `A Chrome window opened for ${config.name}. Log in there (passkeys work), then click Check now.`
                    : `Checking Chrome for ${config.name}. If needed, log in there — we'll detect it automatically.`
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

      case "platform:register": {
        const payload = message.payload as PlatformRegisterPayload;
        if (!payload.url?.trim()) {
          sendError(ws, message.id, "url is required");
          return;
        }

        const {
          registerCustomPlatformConnection,
        } = await import("../services/platforms/customPlatformConnections.js");
        const { refreshCustomPlatformConfigCache } = await import(
          "../services/platforms/platformRegistry.js"
        );

        const record = await registerCustomPlatformConnection({
          url: payload.url,
          name: payload.name,
          registeredBy: "user",
        });
        await refreshCustomPlatformConfigCache();

        sendResponse(ws, {
          id: message.id,
          success: true,
          data: record,
        });
        break;
      }

      case "platform:unregister": {
        const payload = message.payload as PlatformUnregisterPayload;
        if (!payload.platformId) {
          sendError(ws, message.id, "platformId is required");
          return;
        }

        const config = getPlatformConfig(payload.platformId);
        if (!config?.isCustom) {
          sendError(ws, message.id, "Only custom platform connections can be removed");
          return;
        }

        const sessionService = getPlatformSessionService();
        await sessionService.initialize();
        await sessionService.disconnect(payload.platformId);

        const {
          unregisterCustomPlatformConnection,
        } = await import("../services/platforms/customPlatformConnections.js");
        const { refreshCustomPlatformConfigCache } = await import(
          "../services/platforms/platformRegistry.js"
        );

        const removed = await unregisterCustomPlatformConnection(payload.platformId);
        await refreshCustomPlatformConfigCache();

        sendResponse(ws, {
          id: message.id,
          success: removed,
          data: { platformId: payload.platformId, removed },
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
