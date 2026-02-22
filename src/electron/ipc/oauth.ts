/**
 * OAuth IPC Handlers - Handle OAuth authentication requests from renderer
 */

import { ipcMain, shell } from "electron";
import { OAuthTokenStorage } from "../../core/storage/OAuthTokenStorage.js";
import type { CustomKeysStorage } from "../../core/storage/CustomKeysStorage.js";
import { OpenAIOAuthService } from "../../core/services/OpenAIOAuthService.js";
import { ClaudeOAuthService } from "../../core/services/ClaudeOAuthService.js";
import { OAuthCallbackServer } from "../../core/services/OAuthCallbackServer.js";

let oauthTokenStorage: OAuthTokenStorage | null = null;
let customKeysStorage: CustomKeysStorage | null = null;
let openaiOAuthService: OpenAIOAuthService | null = null;
let claudeOAuthService: ClaudeOAuthService | null = null;

// Active callback servers
const activeServers = new Map<string, OAuthCallbackServer>();

// Active OAuth flows (store PKCE data)
const activeFlows = new Map<
  string,
  {
    pkce: { verifier: string; state: string };
    provider: "openai" | "anthropic";
  }
>();

// Token refresh timer
let refreshTimer: NodeJS.Timeout | null = null;
const REFRESH_CHECK_INTERVAL = 5 * 60 * 1000; // Check every 5 minutes
const REFRESH_BUFFER = 5 * 60; // Refresh 5 minutes before expiry

/**
 * Sync OAuth token to CustomKeysStorage as an API key
 * This makes the OAuth token available to jobs, bash, and agents
 */
async function syncOAuthTokenToApiKeys(
  provider: "openai" | "anthropic",
  accessToken: string,
): Promise<void> {
  if (!customKeysStorage) {
    console.error("[OAuth IPC] CustomKeysStorage not initialized");
    return;
  }

  const keyName =
    provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  const description =
    provider === "openai"
      ? "ChatGPT Plus/Pro OAuth Token (Auto-managed)"
      : "Claude Pro/Max OAuth Token (Auto-managed)";

  try {
    // Check if key already exists
    const existingKeyMetadata =
      await customKeysStorage.getKeyMetadataByName(keyName);

    if (existingKeyMetadata) {
      // Update existing key with new token
      const updatedKey = {
        ...existingKeyMetadata,
        description,
        permission: "always" as const,
        encryptedValue: (customKeysStorage as any).encryptValue(accessToken),
        updatedAt: new Date().toISOString(),
        source: "oauth" as const,
        managedBy: "oauth" as const,
        oauthProvider: provider,
      };

      (customKeysStorage as any).keys.set(existingKeyMetadata.id, updatedKey);
      await (customKeysStorage as any).saveKeys();
      console.log(`[OAuth IPC] Updated ${keyName} with OAuth token`);
    } else {
      // Create new key
      const id = `key-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const now = new Date().toISOString();

      const newKey = {
        id,
        name: keyName,
        description,
        permission: "always" as const,
        encryptedValue: (customKeysStorage as any).encryptValue(accessToken),
        createdAt: now,
        updatedAt: now,
        source: "oauth" as const,
        managedBy: "oauth" as const,
        oauthProvider: provider,
      };

      (customKeysStorage as any).keys.set(id, newKey);
      await (customKeysStorage as any).saveKeys();
      console.log(`[OAuth IPC] Created ${keyName} with OAuth token`);
    }
  } catch (error) {
    console.error(`[OAuth IPC] Failed to sync ${keyName}:`, error);
    throw error;
  }
}

/**
 * Remove OAuth-managed API key from CustomKeysStorage
 */
async function removeOAuthManagedApiKey(
  provider: "openai" | "anthropic",
): Promise<void> {
  if (!customKeysStorage) {
    console.error("[OAuth IPC] CustomKeysStorage not initialized");
    return;
  }

  const keyName =
    provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";

  try {
    const existingKeyMetadata =
      await customKeysStorage.getKeyMetadataByName(keyName);
    if (existingKeyMetadata) {
      // Only delete if it's OAuth-managed
      if (
        existingKeyMetadata.source === "oauth" ||
        existingKeyMetadata.managedBy === "oauth"
      ) {
        await customKeysStorage.deleteKey(existingKeyMetadata.id);
        console.log(`[OAuth IPC] Removed OAuth-managed ${keyName}`);
      } else {
        console.log(
          `[OAuth IPC] Skipping ${keyName} - not OAuth-managed (user added manually)`,
        );
      }
    }
  } catch (error) {
    console.error(`[OAuth IPC] Failed to remove ${keyName}:`, error);
  }
}

/**
 * Refresh OAuth token if it's about to expire
 */
async function refreshTokenIfNeeded(
  provider: "openai" | "anthropic",
): Promise<boolean> {
  if (!oauthTokenStorage) {
    console.error("[OAuth IPC] OAuthTokenStorage not initialized");
    return false;
  }

  try {
    const token = oauthTokenStorage.getTokenByProvider(provider);
    if (!token) {
      console.log(`[OAuth IPC] No ${provider} token to refresh`);
      return false;
    }

    // Check if token needs refresh (within buffer time)
    if (!oauthTokenStorage.isTokenExpired(token, REFRESH_BUFFER / 60)) {
      // Token is still valid, no refresh needed
      return false;
    }

    console.log(`[OAuth IPC] Refreshing ${provider} token (expires soon)`);

    // Get the appropriate OAuth service
    const service =
      provider === "openai" ? openaiOAuthService : claudeOAuthService;
    if (!service) {
      console.error(
        `[OAuth IPC] OAuth service for ${provider} not initialized`,
      );
      return false;
    }

    // Refresh the token
    const tokenInput = await service.refreshToken(token.refreshToken);

    // Update token in OAuthTokenStorage
    await oauthTokenStorage.updateToken(token.id, {
      accessToken: tokenInput.accessToken,
      refreshToken: tokenInput.refreshToken,
      expiresIn: tokenInput.expiresIn,
    });

    // Sync refreshed token to CustomKeysStorage
    await syncOAuthTokenToApiKeys(provider, tokenInput.accessToken);

    console.log(`[OAuth IPC] Successfully refreshed ${provider} token`);
    return true;
  } catch (error) {
    console.error(`[OAuth IPC] Failed to refresh ${provider} token:`, error);
    // TODO: Notify user about refresh failure
    return false;
  }
}

/**
 * Check all tokens and refresh if needed (called periodically)
 */
async function checkAndRefreshTokens(): Promise<void> {
  console.log("[OAuth IPC] Checking tokens for refresh...");

  // Check both providers
  await refreshTokenIfNeeded("openai");
  await refreshTokenIfNeeded("anthropic");
}

/**
 * Start the token refresh timer
 */
function startRefreshTimer(): void {
  if (refreshTimer) {
    console.log("[OAuth IPC] Refresh timer already running");
    return;
  }

  console.log(
    `[OAuth IPC] Starting token refresh timer (checks every ${REFRESH_CHECK_INTERVAL / 60000} minutes)`,
  );

  // Check immediately on start
  checkAndRefreshTokens();

  // Then check periodically
  refreshTimer = setInterval(() => {
    checkAndRefreshTokens();
  }, REFRESH_CHECK_INTERVAL);
}

/**
 * Stop the token refresh timer
 */
function stopRefreshTimer(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
    console.log("[OAuth IPC] Stopped token refresh timer");
  }
}

/**
 * Initialize OAuth IPC handlers
 */
export async function initializeOAuthIPC(keysStorage: CustomKeysStorage) {
  console.log("[OAuth IPC] Initializing...");

  // Store reference to CustomKeysStorage for syncing
  customKeysStorage = keysStorage;

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
              flow.pkce.state,
            );

            // Store tokens in OAuthTokenStorage
            await oauthTokenStorage!.storeToken(tokenInput);

            // Sync token to CustomKeysStorage (makes it available as OPENAI_API_KEY)
            await syncOAuthTokenToApiKeys("openai", tokenInput.accessToken);

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
      // Remove OAuth token from OAuthTokenStorage
      await oauthTokenStorage!.deleteTokenByProvider("openai");
      activeFlows.delete("openai");

      // Remove OAuth-managed API key from CustomKeysStorage
      await removeOAuthManagedApiKey("openai");

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
              flow.pkce.state,
            );

            // Store tokens in OAuthTokenStorage
            await oauthTokenStorage!.storeToken(tokenInput);

            // Sync token to CustomKeysStorage (makes it available as ANTHROPIC_API_KEY)
            await syncOAuthTokenToApiKeys("anthropic", tokenInput.accessToken);

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
      // Remove OAuth token from OAuthTokenStorage
      await oauthTokenStorage!.deleteTokenByProvider("anthropic");
      activeFlows.delete("anthropic");

      // Remove OAuth-managed API key from CustomKeysStorage
      await removeOAuthManagedApiKey("anthropic");

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

  // Start the token refresh timer
  startRefreshTimer();

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
  // Stop refresh timer
  stopRefreshTimer();

  // Stop callback servers
  for (const [provider, server] of activeServers.entries()) {
    console.log(`[OAuth IPC] Stopping ${provider} callback server`);
    server.stop();
  }
  activeServers.clear();
  activeFlows.clear();
}
