/**
 * WebSocket Communication Layer
 *
 * Replaces Electron IPC with WebSocket messages
 */

import type { WebSocketServer, WebSocket } from "ws";
import { setupAgentHandlers } from "./agent.js";
import { setupChatHandlers } from "./chat.js";
import { setupDocumentHandlers } from "./document.js";
import { setupAppHandlers } from "./app.js";
import { setupJobsHandlers } from "./jobs.js";
import { setupSkillHandlers } from "./skill.js";
import { setupBundleHandlers } from "./bundle.js";
import { setupTemplateHandlers } from "./template.js";
import { setupSubAgentHandlers } from "./subagent.js";
import { setupSettingsHandlers } from "./settings.js";
import { setupDbHandlers } from "./db.js";
import { setupChatGPTHandlers } from "./chatgpt.js";
import { setupCodeIndexingHandlers } from "./code-indexing.js";
import { setupMemoryHandlers } from "./memory.js";

export interface WSMessage {
  id: string;
  type: string;
  payload?: unknown;
}

export interface WSResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
  type?: string;
}

// Global WebSocketServer reference for broadcasting
let wssInstance: WebSocketServer | null = null;

/**
 * Set the WebSocketServer instance for broadcasting
 */
export function setWebSocketServer(wss: WebSocketServer): void {
  wssInstance = wss;
}

/**
 * Broadcast a message to all connected clients
 */
export function broadcast(message: { type: string; data?: unknown }): void {
  if (!wssInstance) {
    console.warn("[WebSocket] Cannot broadcast - server not initialized");
    return;
  }

  const payload = JSON.stringify(message);
  wssInstance.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  });
}

/**
 * Send response back to client
 */
export function sendResponse(ws: WebSocket, message: WSResponse): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

/**
 * Send error response
 */
export function sendError(
  ws: WebSocket,
  id: string,
  error: Error | string,
): void {
  const errorMessage = error instanceof Error ? error.message : error;
  sendResponse(ws, {
    id,
    success: false,
    error: errorMessage,
  });
}

/**
 * Setup all WebSocket handlers
 */
export function setupWebSocketHandlers(wss: WebSocketServer): void {
  console.log("[WebSocket] Setting up handlers...");

  // Store WSS instance for broadcasting
  setWebSocketServer(wss);

  wss.on("connection", (ws: WebSocket) => {
    const connectionTime = Date.now();
    console.log(`[WebSocket] Client connected at ${new Date(connectionTime).toISOString()}`);

    // Setup message handlers
    ws.on("message", async (data: Buffer) => {
      //const messageStartTime = Date.now();
      try {
        const message: WSMessage = JSON.parse(data.toString());
        //console.log(`[WebSocket] Received ${message.type} at +${messageStartTime - connectionTime}ms`);

        // Route to appropriate handler
        if (message.type === "ping") {
          // Heartbeat ping - respond with pong
          sendResponse(ws, {
            id: message.id,
            success: true,
            type: "pong",
          });
        } else if (message.type.startsWith("agent:")) {
          await setupAgentHandlers(ws, message);
        } else if (message.type.startsWith("chat:")) {
          await setupChatHandlers(ws, message);
        } else if (message.type.startsWith("document:")) {
          await setupDocumentHandlers(ws, message);
        } else if (message.type.startsWith("app:")) {
          await setupAppHandlers(ws, message);
        } else if (message.type.startsWith("jobs:")) {
          await setupJobsHandlers(ws, message);
        } else if (message.type.startsWith("skill:")) {
          await setupSkillHandlers(ws, message);
        } else if (message.type.startsWith("bundle:")) {
          await setupBundleHandlers(ws, message);
        } else if (message.type.startsWith("template:")) {
          await setupTemplateHandlers(ws, message);
        } else if (message.type.startsWith("subagent:")) {
          await setupSubAgentHandlers(ws, message);
        } else if (message.type.startsWith("settings:")) {
          await setupSettingsHandlers(ws, message);
        } else if (message.type.startsWith("db:")) {
          await setupDbHandlers(ws, message);
        } else if (message.type.startsWith("chatgpt:")) {
          await setupChatGPTHandlers(ws, message);
        } else if (message.type.startsWith("code-indexing:")) {
          await setupCodeIndexingHandlers(ws, message);
        } else if (message.type.startsWith("memory:")) {
          await setupMemoryHandlers(ws, message);
        } else if (message.type.startsWith("custom-keys:")) {
          // Custom keys are now handled via Electron IPC, not WebSocket
          // No action needed here - handled in customKeys.ts
        } else if (message.type === "geolocation:get-from-ip") {
          // Handle geolocation directly in Gateway (Node.js has no CORS)
          // Using ip-api.com (free, 45 requests/minute, no API key needed)
          try {
            const response = await fetch("http://ip-api.com/json/");
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}`);
            }
            const data = (await response.json()) as {
              lat?: number;
              lon?: number;
              city?: string;
              region?: string; // State code like "CA"
              regionName?: string; // Full state name like "California"
              country?: string;
              countryCode?: string;
              status?: string;
            };

            if (
              data.status === "success" &&
              data.lat &&
              data.lon &&
              data.city
            ) {
              sendResponse(ws, {
                id: message.id,
                success: true,
                data: {
                  latitude: data.lat,
                  longitude: data.lon,
                  city: data.city,
                  region: data.region, // Use abbreviated state code
                  country: data.country,
                  country_code: data.countryCode,
                },
              });
            } else {
              sendError(ws, message.id, "Invalid IP geolocation response");
            }
          } catch (error) {
            console.error("[Gateway] Geolocation error:", error);
            sendError(
              ws,
              message.id,
              error instanceof Error ? error.message : "Geolocation failed",
            );
          }
        } else {
          sendError(ws, message.id, `Unknown message type: ${message.type}`);
        }
      } catch (error) {
        console.error("[WebSocket] Error handling message:", error);
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        ws.send(
          JSON.stringify({
            id: "error",
            success: false,
            error: errorMessage,
          }),
        );
      }
    });

    ws.on("close", () => {
      console.log("[WebSocket] Client disconnected");
    });

    ws.on("error", (error) => {
      console.error("[WebSocket] Connection error:", error);
    });
  });

  console.log("[WebSocket] Handlers ready");
}
