/**
 * OAuth IPC Handlers - Handle OAuth authentication requests from renderer
 */

import { ipcMain, shell } from "electron";
import { OAuthTokenStorage } from "../../core/storage/OAuthTokenStorage.js";
import { OpenAIOAuthService } from "../../core/services/OpenAIOAuthService.js";
import { ClaudeOAuthService } from "../../core/services/ClaudeOAuthService.js";
import { OAuthCallbackServer } from "../../core/services/OAuthCallbackServer.js";

let oauthTokenStorage: OAuthTokenStorage | null = null;
let openaiOAuthService: OpenAIOAuthService | null = null;
let claudeOAuthService: ClaudeOAuthService | null = null;

// Active callback servers
const activeServers = new Map<string, OAuthCallbackServer>();

// Active OAuth flows (store PKCE data)
const activeFlows = new Map<
  string,
  { pkce: { verifier: string; state: string }; provider: "openai" | "anthropic" }
>();

/**
 * Initialize OAuth IPC handlers
 */
export async function initializeOAuthIPC() {
  console.log("[OAuth IPC] Initializing...");

  // Initialize storage and services
  oauthTokenStorage = new OAuthTokenStorage();
  await oauthTokenStorage.initialize();

  openaiOAuthService = new OpenAIOAuthService();
  claudeOAuthService = new ClaudeOAuthService();

  // OpenAI OAuth handlers
  ipcMain.handle("auth:openai:start-oauth", async () => {
    try {
      console.log("[OAuth IPC] Starting OpenAI OAuth flow");

      // Stop any existing server
      const existingServer = activeServers.get("openai");
      if (existingServer) {
        existingServer.stop();
        activeServers.delete("openai");
      }

      // Start OAuth flow
      const { url, pkce } = openaiOAuthService!.startOAuthFlow();

      // Store PKCE data for callback
      activeFlows.set("openai", {
        pkce: { verifier: pkce.verifier, state: pkce.state },
        provider: "openai",
      });

      // Start callback server
      const server = new OAuthCallbackServer({
        port: 1455,
        timeout: 300000, // 5 minutes
        onCallback: async (params) => {
          try {
            const code = params.get("code");
            const state = params.get("state");
            const flow = activeFlows.get("openai");

            if (!code || !state || !flow) {
              console.error("[OAuth IPC] Missing code, state, or flow data");
              return;
            }

            // Exchange code for tokens
            const tokenInput = await openaiOAuthService!.handleCallback(
              code,
              flow.pkce.verifier,
              state,
              flow.pkce.state
            );

            // Store tokens
            await oauthTokenStorage!.storeToken(tokenInput);

            console.log("[OAuth IPC] OpenAI OAuth flow completed successfully");
            activeFlows.delete("openai");
          } catch (error) {
            console.error("[OAuth IPC] OpenAI callback error:", error);
            activeFlows.delete("openai");
          }
        },
      });

      await server.start();
      activeServers.set("openai", server);

      // Open browser to authorization URL
      await shell.openExternal(url);

      return { success: true, url };
    } catch (error) {
      console.error("[OAuth IPC] Failed to start OpenAI OAuth:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  ipcMain.handle("auth:openai:get-status", async () => {
    try {
      const token = oauthTokenStorage!.getTokenByProvider("openai");

      if (!token) {
        return { connected: false };
      }

      const isExpired = oauthTokenStorage!.isTokenExpired(token, 0);

      return {
        connected: true,
        accountId: token.accountId,
        expiresAt: token.expiresAt,
        isExpired,
      };
    } catch (error) {
      console.error("[OAuth IPC] Failed to get OpenAI status:", error);
      return { connected: false, error: (error as Error).message };
    }
  });

  ipcMain.handle("auth:openai:disconnect", async () => {
    try {
      await oauthTokenStorage!.deleteTokenByProvider("openai");
      activeFlows.delete("openai");

      // Stop server if running
      const server = activeServers.get("openai");
      if (server) {
        server.stop();
        activeServers.delete("openai");
      }

      return { success: true };
    } catch (error) {
      console.error("[OAuth IPC] Failed to disconnect OpenAI:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  // Claude OAuth handlers
  ipcMain.handle("auth:claude:start-oauth", async () => {
    try {
      console.log("[OAuth IPC] Starting Claude OAuth flow");

      // Stop any existing server
      const existingServer = activeServers.get("anthropic");
      if (existingServer) {
        existingServer.stop();
        activeServers.delete("anthropic");
      }

      // Start OAuth flow
      const { url, pkce } = claudeOAuthService!.startOAuthFlow();

      // Store PKCE data for callback
      activeFlows.set("anthropic", {
        pkce: { verifier: pkce.verifier, state: pkce.state },
        provider: "anthropic",
      });

      // Start callback server (use different port or handle redirect)
      // Note: Claude's redirect URI is console.anthropic.com, so we need to handle this differently
      // For now, we'll use a local server and ask user to copy the code
      const server = new OAuthCallbackServer({
        port: 1456,
        timeout: 300000, // 5 minutes
        onCallback: async (params) => {
          try {
            const codeWithState = params.get("code");
            const flow = activeFlows.get("anthropic");

            if (!codeWithState || !flow) {
              console.error("[OAuth IPC] Missing code or flow data");
              return;
            }

            // Exchange code for tokens
            const tokenInput = await claudeOAuthService!.handleCallback(
              codeWithState,
              flow.pkce.verifier,
              flow.pkce.state
            );

            // Store tokens
            await oauthTokenStorage!.storeToken(tokenInput);

            console.log("[OAuth IPC] Claude OAuth flow completed successfully");
            activeFlows.delete("anthropic");
          } catch (error) {
            console.error("[OAuth IPC] Claude callback error:", error);
            activeFlows.delete("anthropic");
          }
        },
      });

      await server.start();
      activeServers.set("anthropic", server);

      // Open browser to authorization URL
      await shell.openExternal(url);

      return { success: true, url };
    } catch (error) {
      console.error("[OAuth IPC] Failed to start Claude OAuth:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  ipcMain.handle("auth:claude:get-status", async () => {
    try {
      const token = oauthTokenStorage!.getTokenByProvider("anthropic");

      if (!token) {
        return { connected: false };
      }

      const isExpired = oauthTokenStorage!.isTokenExpired(token, 0);

      return {
        connected: true,
        accountId: token.accountId,
        expiresAt: token.expiresAt,
        isExpired,
      };
    } catch (error) {
      console.error("[OAuth IPC] Failed to get Claude status:", error);
      return { connected: false, error: (error as Error).message };
    }
  });

  ipcMain.handle("auth:claude:disconnect", async () => {
    try {
      await oauthTokenStorage!.deleteTokenByProvider("anthropic");
      activeFlows.delete("anthropic");

      // Stop server if running
      const server = activeServers.get("anthropic");
      if (server) {
        server.stop();
        activeServers.delete("anthropic");
      }

      return { success: true };
    } catch (error) {
      console.error("[OAuth IPC] Failed to disconnect Claude:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  console.log("[OAuth IPC] Initialized successfully");
}

/**
 * Get OAuth token storage (for internal use)
 */
export function getOAuthTokenStorage(): OAuthTokenStorage | null {
  return oauthTokenStorage;
}

/**
 * Cleanup on app quit
 */
export function cleanupOAuthServers(): void {
  for (const [provider, server] of activeServers.entries()) {
    console.log(`[OAuth IPC] Stopping ${provider} callback server`);
    server.stop();
  }
  activeServers.clear();
  activeFlows.clear();
}
