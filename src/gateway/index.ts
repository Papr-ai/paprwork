/**
 * Gateway Process Entry Point
 *
 * Pure Node.js server (no Electron dependencies)
 * - WebSocket server for client communication
 * - HTTP server for UI assets
 * - Agent and Chat services
 * 
 * API Keys:
 * - Passed from Electron via environment variables
 * - Electron fetches them from macOS Keychain
 * - No .env files in production (packaged app)
 */

// CRITICAL: Ensure crypto is available globally for @mastra/core
// In newer Node.js versions (v16+), crypto is already global
// In older versions or some environments, we need to import it
import crypto from "crypto";
if (!globalThis.crypto) {
  // Only set if not already present
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).crypto = crypto;
}

import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import { initializeAgentService } from "./services/AgentService.js";
import { initializeChatService } from "./services/ChatService.js";
import { initializeDocumentService } from "./services/DocumentService.js";
import { initializeAppService } from "./services/AppService.js";
import { setupWebSocketHandlers } from "./websocket/index.js";
import {
  initializePermissionBridge,
  requestPermissionFromMain,
} from "./permissions/GatewayPermissionBridge.js";
import { setPermissionRequester } from "./permissions/PermissionRequester.js";
import type { KeyPermissionRequest } from "../core/types/permissions.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const PORT = process.env.GATEWAY_PORT || 18789;
// Listen on all interfaces (0.0.0.0) to accept connections from both localhost and 127.0.0.1
const HOST = process.env.GATEWAY_HOST || "0.0.0.0";

/**
 * Initialize all services
 */
async function initializeServices(): Promise<void> {
  console.log("[Gateway] Initializing services...");

  try {
    // DON'T request keys on startup! 
    // AgentService will lazy-load them when first message is sent
    // This ensures ZERO keychain popups on app startup (matches V1 behavior)
    
    let storageMode: 'local' | 'papr' | 'hybrid';
    
    if (process.env.STORAGE_MODE) {
      // Use explicit mode if set
      storageMode = process.env.STORAGE_MODE as 'local' | 'papr' | 'hybrid';
    } else {
      // Default to local mode on startup
      // AgentService will upgrade to hybrid/papr when keys are available
      storageMode = 'local';
      console.log("[Gateway] Starting in local mode (keys will load on first use)");
    }

    await initializeAgentService({
      mode: storageMode,
      paprApiKey: undefined, // Will be loaded lazily
      openaiApiKey: undefined, // Will be loaded lazily
    });

    // Initialize other services
    await Promise.all([
      initializeChatService(),
      initializeDocumentService(),
      initializeAppService(),
    ]);

    console.log("[Gateway] All services initialized");
    console.log(`[Gateway] Storage mode: ${storageMode} (keys will load on demand)`);
  } catch (error) {
    console.error("[Gateway] Failed to initialize services:", error);
    throw error;
  }
}

/**
 * Start the Gateway server
 */
async function startGateway(): Promise<void> {
  console.log("[Gateway] Paprwork V2 Gateway starting...");
  console.log("[Gateway] Platform:", process.platform);
  console.log("[Gateway] Node:", process.version);

  try {
    // Initialize permission system
    console.log("[Gateway] Initializing permission system...");
    initializePermissionBridge();
    setPermissionRequester(async (request: KeyPermissionRequest) => {
      return await requestPermissionFromMain(request);
    });
    console.log("[Gateway] Permission system initialized");

    // Initialize services first
    await initializeServices();

    // Create Express app
    const app = express();
    const server = createServer(app);

    // Create WebSocket server
    const wss = new WebSocketServer({ server });
    console.log("[Gateway] WebSocket server created");

    // Setup WebSocket handlers
    setupWebSocketHandlers(wss);

    // Health check endpoint (before static files)
    app.get("/health", (_req, res) => {
      res.json({ status: "ok", timestamp: Date.now() });
    });

    // Serve UI assets in production
    if (process.env.NODE_ENV === "production") {
      const uiPath = path.join(__dirname, "../ui");
      
      // Serve static files (CSS, JS, images)
      app.use(express.static(uiPath));
      
      // Catch-all route to serve index.html for SPA routing
      // Must be after static files so assets are served first
      app.use((_req, res) => {
        res.sendFile(path.join(uiPath, "index.html"));
      });
      
      console.log("[Gateway] Serving UI from:", uiPath);
    }

    // Start server with error handling
    await new Promise<void>((resolve, reject) => {
      server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          console.error(`[Gateway] ERROR: Port ${PORT} is already in use!`);
          console.error(`[Gateway] Another Gateway process may be running.`);
          console.error(`[Gateway] Run: npm run kill:gateway`);
          reject(error);
        } else {
          console.error('[Gateway] Server error:', error);
          reject(error);
        }
      });

      server.listen(PORT as number, HOST, () => {
        console.log(`[Gateway] Server listening on http://${HOST}:${PORT}`);
        console.log(`[Gateway] WebSocket available at ws://${HOST}:${PORT}`);
        resolve();
      });
    });

    // Handle shutdown
    const shutdown = async () => {
      console.log("[Gateway] Shutting down...");
      server.close();
      process.exit(0);
    };
    
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    console.error("[Gateway] Failed to start:", error);
    process.exit(1);
  }
}

// Start the gateway
startGateway();

// Handle uncaught errors
process.on("uncaughtException", (error) => {
  console.error("[Gateway] Uncaught exception:", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("[Gateway] Unhandled rejection:", reason);
});
