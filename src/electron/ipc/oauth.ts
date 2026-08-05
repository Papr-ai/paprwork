/**
 * OAuth IPC Handlers - Handle OAuth authentication requests from renderer
 */

import { ipcMain, shell, BrowserWindow } from "electron";
import { OAuthTokenStorage } from "../../core/storage/OAuthTokenStorage.js";
import type { CustomKeysStorage } from "../../core/storage/CustomKeysStorage.js";
import { OpenAIOAuthService } from "../../core/services/OpenAIOAuthService.js";
import { ClaudeOAuthService } from "../../core/services/ClaudeOAuthService.js";
import { ClaudeSetupTokenService } from "../../core/services/ClaudeSetupTokenService.js";
import { OAuthCallbackServer } from "../../core/services/OAuthCallbackServer.js";
import { invalidateKeyCache } from "./customKeys.js";
import { sanitizeOAuthAccessToken } from "../../core/utils/oauthTokenSanitize.js";
import {
  getOAuthCompletedEventName,
  getOAuthFailedEventName,
  getOAuthStepEventName,
  logOAuthProviderStep,
  type OAuthProviderId,
  type OAuthProviderStep,
} from "../../core/telemetry/oauthProviderSteps.js";

type OAuthTelemetryTracker = (
  eventName: string,
  properties?: Record<string, unknown>,
) => void;

let oauthTokenStorage: OAuthTokenStorage | null = null;
let customKeysStorage: CustomKeysStorage | null = null;
let openaiOAuthService: OpenAIOAuthService | null = null;
let claudeSetupTokenService: ClaudeSetupTokenService | null = null;
let claudeOAuthService: ClaudeOAuthService | null = null;
let trackOAuthEvent: OAuthTelemetryTracker | undefined;
const oauthFlowStartedAt = new Map<OAuthProviderId, number>();

function trackOAuthStep(
  provider: OAuthProviderId,
  step: OAuthProviderStep,
  properties?: Record<string, unknown>,
): void {
  const payload: Record<string, unknown> = { step, ...properties };
  if (step === "connected" || step === "connect_failed") {
    const startedAt = oauthFlowStartedAt.get(provider);
    if (startedAt !== undefined) {
      payload.duration_ms = Date.now() - startedAt;
      oauthFlowStartedAt.delete(provider);
    }
  }
  logOAuthProviderStep(provider, step, payload);
  trackOAuthEvent?.(getOAuthStepEventName(provider), payload);
}

function trackOAuthCompleted(
  provider: OAuthProviderId,
  properties?: Record<string, unknown>,
): void {
  trackOAuthEvent?.(getOAuthCompletedEventName(provider), properties);
  trackOAuthEvent?.("paprwork_provider_configured", {
    provider,
    method: "oauth",
    ...properties,
  });
}

function trackOAuthFailed(
  provider: OAuthProviderId,
  error: string,
  properties?: Record<string, unknown>,
): void {
  trackOAuthStep(provider, "connect_failed", { error, ...properties });
  trackOAuthEvent?.(getOAuthFailedEventName(provider), { error, ...properties });
}

async function persistOAuthConnection(
  provider: OAuthProviderId,
  tokenInput: {
    provider: OAuthProviderId;
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    accountId?: string;
  },
  options?: {
    flow_source?: "keychain" | "browser" | "terminal" | "paste";
    source?: string;
    stage?: "start" | "callback" | "paste" | "provisioning";
  },
): Promise<void> {
  await oauthTokenStorage!.storeToken(tokenInput);
  trackOAuthStep(provider, "token_stored", options);

  await syncOAuthTokenToApiKeys(provider, tokenInput.accessToken);
  trackOAuthStep(provider, "key_synced", options);

  trackOAuthStep(provider, "connected", options);
  trackOAuthCompleted(provider, options);
  sendOAuthStatus(provider, "connected");
}

// Active callback servers (OpenAI and Claude PKCE flows)
const activeServers = new Map<string, OAuthCallbackServer>();

// Active OAuth flows (store PKCE data for OpenAI)
const activeFlows = new Map<
  string,
  {
    pkce: { verifier: string; state: string };
    provider: "openai" | "anthropic";
  }
>();


/**
 * Send OAuth status event to all renderer windows
 */
function sendOAuthStatus(provider: "openai" | "anthropic", status: "connected" | "error" | "timeout", error?: string) {
  const wins = BrowserWindow.getAllWindows();
  for (const win of wins) {
    if (!win.isDestroyed()) {
      win.webContents.send("oauth:status", { provider, status, error });
    }
  }
}

// Token refresh timer
let refreshTimer: NodeJS.Timeout | null = null;
const REFRESH_CHECK_INTERVAL = 2 * 60 * 1000; // Check every 2 minutes
const REFRESH_BUFFER = 15 * 60; // Refresh 15 minutes before expiry

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

  const cleanToken = sanitizeOAuthAccessToken(provider, accessToken);

  const keyName =
    provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  const description =
    provider === "openai"
      ? "ChatGPT Plus/Pro OAuth Token (Auto-managed)"
      : "Claude Pro/Max OAuth Token (Auto-managed)";

  try {
    const existingKeyMetadata =
      await customKeysStorage.getKeyMetadataByName(keyName);

    const oauthKeyFields = {
      description,
      permission: "always" as const,
      source: "oauth" as const,
      managedBy: "oauth" as const,
      oauthProvider: provider,
    };

    if (existingKeyMetadata) {
      await customKeysStorage.updateKey(existingKeyMetadata.id, {
        value: cleanToken,
        ...oauthKeyFields,
      });
      invalidateKeyCache(keyName);
      console.log(`[OAuth IPC] Updated ${keyName} with OAuth token`);
    } else {
      await customKeysStorage.addKey({
        name: keyName,
        value: cleanToken,
        orgScope: "all",
        ...oauthKeyFields,
      });
      invalidateKeyCache(keyName);
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

    // Get the appropriate OAuth service for refresh
    let tokenInput;
    if (provider === "anthropic") {
      if (!claudeOAuthService) {
        console.error("[OAuth IPC] Claude OAuth service not initialized");
        return false;
      }
      tokenInput = await claudeOAuthService.refreshToken(token.refreshToken);
    } else {
      if (!openaiOAuthService) {
        console.error("[OAuth IPC] OpenAI OAuth service not initialized");
        return false;
      }
      tokenInput = await openaiOAuthService.refreshToken(token.refreshToken);
    }

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
export async function initializeOAuthIPC(
  keysStorage: CustomKeysStorage,
  options?: {
    trackOAuthEvent?: OAuthTelemetryTracker;
  },
) {
  console.log("[OAuth IPC] Initializing...");
  trackOAuthEvent = options?.trackOAuthEvent;

  // Store reference to CustomKeysStorage for syncing
  customKeysStorage = keysStorage;

  // Initialize storage and services
  oauthTokenStorage = new OAuthTokenStorage();
  await oauthTokenStorage.initialize();

  openaiOAuthService = new OpenAIOAuthService();
  claudeSetupTokenService = new ClaudeSetupTokenService();
  claudeOAuthService = new ClaudeOAuthService();

  // OpenAI OAuth handlers
  ipcMain.handle("auth:openai:start-oauth", async () => {
    try {
      console.log("[OAuth IPC] Starting OpenAI OAuth flow");
      oauthFlowStartedAt.set("openai", Date.now());
      trackOAuthStep("openai", "flow_started");

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

            trackOAuthStep("openai", "callback_received", {
              has_code: Boolean(code),
              has_state: Boolean(state),
            });

            if (!code || !state || !flow) {
              console.error("[OAuth IPC] Missing code, state, or flow data");
              trackOAuthFailed("openai", "Missing code, state, or flow data", {
                stage: "callback",
              });
              return;
            }

            // Exchange code for tokens
            const tokenInput = await openaiOAuthService!.handleCallback(
              code,
              flow.pkce.verifier,
              state,
              flow.pkce.state,
            );
            trackOAuthStep("openai", "token_exchanged");

            await persistOAuthConnection("openai", tokenInput, {
              flow_source: "browser",
            });

            console.log("[OAuth IPC] OpenAI OAuth flow completed successfully");
            activeFlows.delete("openai");
          } catch (error) {
            console.error("[OAuth IPC] OpenAI callback error:", error);
            activeFlows.delete("openai");
            const message = error instanceof Error ? error.message : "Callback failed";
            trackOAuthFailed("openai", message, { stage: "callback" });
            sendOAuthStatus("openai", "error", message);
          }
        },
      });

      await server.start();
      activeServers.set("openai", server);
      trackOAuthStep("openai", "callback_server_started");

      // Open browser to authorization URL
      await shell.openExternal(url);
      trackOAuthStep("openai", "browser_opened");

      return { success: true, url };
    } catch (error) {
      console.error("[OAuth IPC] Failed to start OpenAI OAuth:", error);
      const message = error instanceof Error ? error.message : "Start OAuth failed";
      trackOAuthFailed("openai", message, { stage: "start" });
      return {
        success: false,
        error: message,
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
      trackOAuthStep("openai", "disconnected");
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
  // `claude setup-token` needs a real TTY (uses Ink for interactive input).
  // Flow: (1) check existing credentials, (2) ensure CLI installed, (3) open
  // a real terminal window with the command, (4) UI shows paste field for
  // user to copy token from terminal and paste it.
  ipcMain.handle("auth:claude:start-oauth", async () => {
    try {
      console.log("[OAuth IPC] Starting Claude OAuth flow");
      oauthFlowStartedAt.set("anthropic", Date.now());
      trackOAuthStep("anthropic", "flow_started");

      // Step 0: Check for existing token in Keychain / credential files
      const existingToken = await claudeSetupTokenService!.readTokenFromCLIStorage();
      if (existingToken) {
        console.log("[OAuth IPC] Found existing Claude token in CLI storage");
        trackOAuthStep("anthropic", "keychain_token_found");
        const tokenInput = {
          provider: "anthropic" as const,
          accessToken: existingToken,
          refreshToken: existingToken,
          expiresIn: 365 * 24 * 60 * 60,
        };
        await persistOAuthConnection("anthropic", tokenInput, {
          flow_source: "keychain",
        });
        return { success: true, source: "keychain" };
      }

      // Step 1: Ensure Claude CLI is installed (uses shell PATH resolution)
      const isInstalled = await claudeSetupTokenService!.isClaudeCLIInstalled();
      if (!isInstalled) {
        console.log("[OAuth IPC] Claude CLI not found, installing...");
        trackOAuthStep("anthropic", "cli_install_started");
        const installResult = await claudeSetupTokenService!.installClaudeCLI();
        if (!installResult.success) {
          console.error("[OAuth IPC] Failed to install Claude CLI:", installResult.error);
          const message = "Could not install Claude CLI. Use Manual Setup instead.";
          trackOAuthStep("anthropic", "cli_install_failed", {
            error: installResult.error,
          });
          trackOAuthFailed("anthropic", message, { stage: "start" });
          sendOAuthStatus("anthropic", "error", message);
          return { success: false, error: "CLI install failed", fallback: "manual" };
        }
        console.log("[OAuth IPC] Claude CLI installed");
      }

      // Step 2: Open a real terminal window with `claude setup-token`
      console.log("[OAuth IPC] Opening terminal with claude setup-token...");
      const { exec: execCb } = await import("child_process");

      let terminalOpened = false;
      try {
        if (process.platform === "darwin") {
          execCb(`osascript -e 'tell application "Terminal" to do script "claude setup-token"' -e 'tell application "Terminal" to activate'`);
          terminalOpened = true;
        } else if (process.platform === "win32") {
          execCb(`start cmd.exe /k "claude setup-token"`);
          terminalOpened = true;
        } else {
          execCb(`x-terminal-emulator -e "claude setup-token" 2>/dev/null || gnome-terminal -- bash -c "claude setup-token; exec bash" 2>/dev/null || xterm -e "claude setup-token" 2>/dev/null`);
          terminalOpened = true;
        }
      } catch (termErr) {
        console.error("[OAuth IPC] Failed to open terminal:", termErr);
      }

      trackOAuthStep("anthropic", "terminal_opened", { terminal_opened: terminalOpened });

      return { success: true, source: "terminal-opened", terminalOpened };
    } catch (error) {
      console.error("[OAuth IPC] Failed to start Claude OAuth:", error);
      const message = error instanceof Error ? error.message : "Start OAuth failed";
      trackOAuthFailed("anthropic", message, { stage: "start" });
      sendOAuthStatus("anthropic", "error", message);
      return {
        success: false,
        error: message,
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

  ipcMain.handle("auth:claude:get-token", async () => {
    try {
      const token = oauthTokenStorage!.getTokenByProvider("anthropic");
      if (!token) {
        return { success: false, error: "No token found" };
      }
      return { success: true, token: token.accessToken };
    } catch (error) {
      console.error("[OAuth IPC] Failed to get Claude token:", error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle("auth:claude:disconnect", async () => {
    try {
      trackOAuthStep("anthropic", "disconnected");
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

  // Claude OAuth: Paste token (alternative to full OAuth flow)
  ipcMain.handle("auth:claude:paste-token", async (_event, token: string) => {
    try {
      console.log("[OAuth IPC] Pasting Claude OAuth token");
      if (!oauthFlowStartedAt.has("anthropic")) {
        oauthFlowStartedAt.set("anthropic", Date.now());
      }
      trackOAuthStep("anthropic", "paste_token_submitted", {
        stage: "paste",
        flow_source: "paste",
      });

      // Validate token format (Claude OAuth tokens start with sk-ant-oat)
      if (!token || typeof token !== "string") {
        trackOAuthFailed("anthropic", "Token is required", { stage: "paste" });
        return {
          success: false,
          error: "Token is required",
        };
      }

      const cleanedToken = sanitizeOAuthAccessToken("anthropic", token);

      if (!cleanedToken.startsWith("sk-ant-oat")) {
        trackOAuthFailed("anthropic", "Invalid token format", { stage: "paste" });
        return {
          success: false,
          error:
            "Invalid token format. Claude OAuth tokens start with sk-ant-oat",
        };
      }

      const tokenInput = {
        provider: "anthropic" as const,
        accessToken: cleanedToken,
        refreshToken: cleanedToken,
        expiresIn: 365 * 24 * 60 * 60,
      };

      await persistOAuthConnection("anthropic", tokenInput, {
        flow_source: "paste",
        stage: "paste",
      });

      console.log("[OAuth IPC] Claude OAuth token stored successfully");
      return { success: true };
    } catch (error) {
      console.error("[OAuth IPC] Failed to paste Claude token:", error);
      const message = error instanceof Error ? error.message : "Paste token failed";
      trackOAuthFailed("anthropic", message, { stage: "paste" });
      return {
        success: false,
        error: message,
      };
    }
  });

  // Force-refresh handler (called by gateway on 401)
  ipcMain.handle("auth:force-refresh", async (_event, provider: "openai" | "anthropic") => {
    try {
      console.log(`[OAuth IPC] Force-refreshing ${provider} token (triggered by 401)`);
      const refreshed = await refreshTokenIfNeeded(provider);
      if (!refreshed) {
        // Token wasn't near expiry but we got a 401 — force it anyway
        if (!oauthTokenStorage) return { success: false, error: "Storage not initialized" };
        const token = oauthTokenStorage.getTokenByProvider(provider);
        if (!token) return { success: false, error: "No token found" };

        let tokenInput;
        if (provider === "anthropic" && claudeOAuthService) {
          tokenInput = await claudeOAuthService.refreshToken(token.refreshToken);
        } else if (provider === "openai" && openaiOAuthService) {
          tokenInput = await openaiOAuthService.refreshToken(token.refreshToken);
        } else {
          return { success: false, error: "OAuth service not initialized" };
        }

        await oauthTokenStorage.updateToken(token.id, {
          accessToken: tokenInput.accessToken,
          refreshToken: tokenInput.refreshToken,
          expiresIn: tokenInput.expiresIn,
        });
        await syncOAuthTokenToApiKeys(provider, tokenInput.accessToken);
        console.log(`[OAuth IPC] Force-refreshed ${provider} token successfully`);
        return { success: true, accessToken: tokenInput.accessToken };
      }
      return { success: true };
    } catch (error) {
      console.error(`[OAuth IPC] Force-refresh failed for ${provider}:`, error);
      return { success: false, error: (error as Error).message };
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
  trackOAuthEvent = undefined;
  oauthFlowStartedAt.clear();
  // Stop refresh timer
  stopRefreshTimer();

  // Stop callback servers (OpenAI only)
  for (const [provider, server] of activeServers.entries()) {
    console.log(`[OAuth IPC] Stopping ${provider} callback server`);
    server.stop();
  }
  activeServers.clear();
  activeFlows.clear();
}
