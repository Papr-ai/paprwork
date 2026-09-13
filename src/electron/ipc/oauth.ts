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
  claudeAccessTokenIsLive,
  claudeCredentialsToTokenLifetime,
  isUsableRefreshToken,
  type ClaudeCliCredentials,
} from "../../core/services/claudeCliCredentials.js";
import {
  isInvalidGrantError,
  RefreshRejectionLedger,
} from "../../core/services/oauthRefreshRejection.js";
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

type OAuthStartTelemetryOptions = {
  source?: string;
};

/**
 * A pasted `claude setup-token` carries no expiry of its own, and Anthropic
 * issues those for about a year. Consulted only when the source told us
 * nothing: credentials read from Claude Code's own storage bring a real
 * expiresAt, and assuming a year for those is what let an access token that
 * had already died keep reporting itself as connected.
 */
const SETUP_TOKEN_ASSUMED_TTL_SECONDS = 365 * 24 * 60 * 60;

function resolveOAuthTelemetrySource(source?: string): string {
  if (source === "onboarding" || source === "settings") {
    return source;
  }
  return "unknown";
}

let oauthTokenStorage: OAuthTokenStorage | null = null;
let customKeysStorage: CustomKeysStorage | null = null;
let openaiOAuthService: OpenAIOAuthService | null = null;
let claudeSetupTokenService: ClaudeSetupTokenService | null = null;
let claudeOAuthService: ClaudeOAuthService | null = null;
let trackOAuthEvent: OAuthTelemetryTracker | undefined;
const oauthFlowStartedAt = new Map<OAuthProviderId, number>();
const refreshRejections = new RefreshRejectionLedger();

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
  // A new token is worth one fresh look at the CLI's credentials.
  cliAdoptionAttempted.delete(provider);
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
 * Providers whose stored token we have already tried to upgrade from the CLI's
 * own credentials this session.
 *
 * Cleared whenever the stored token changes, since a fresh sign-in is exactly
 * the event that makes another look worthwhile.
 */
const cliAdoptionAttempted = new Set<"openai" | "anthropic">();

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
  const keyName =
    provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";

  if (!customKeysStorage) {
    console.error("[OAuth IPC] CustomKeysStorage not initialized");
    invalidateKeyCache(keyName);
    return;
  }

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
    // Token was removed from OAuthTokenStorage even when a user-owned key remains.
    // Gateway must drop oauthTokenCache + bump authEpoch or stale OAuth wins on next turn.
    invalidateKeyCache(keyName);
  } catch (error) {
    console.error(`[OAuth IPC] Failed to remove ${keyName}:`, error);
    invalidateKeyCache(keyName);
  }
}

/**
 * Replace our stored Claude token with a fresh read of Claude Code's own
 * credentials. Claude Code keeps its access token renewed, so adopting its
 * record recovers both a redeemable refresh token and a truthful expiry.
 *
 * Returns whether anything was adopted.
 */
/**
 * Whether the stored token can actually mint a new access token.
 *
 * Well-formedness is necessary but not sufficient: a grant the provider has
 * already answered `invalid_grant` to renews nothing, however valid it looks.
 * Reporting it as renewable is what let the card stay reassuring while every
 * refresh was being refused.
 */
function tokenCanRenew(
  provider: "openai" | "anthropic",
  token: { refreshToken: string; accessToken: string },
): boolean {
  if (!isUsableRefreshToken(token.refreshToken, token.accessToken)) return false;
  return !refreshRejections.isRejected(provider, token.refreshToken);
}

/**
 * Decide whether Claude Code's stored credentials can be adopted instead of
 * sending the user to a terminal, renewing them first when only the access
 * token has lapsed. Returns null when a real sign-in is required.
 *
 * Pressing Sign in states an intent the short-circuit has to honour. Adopting
 * a credential that cannot authenticate reports success, skips the terminal,
 * and returns the user to the card they pressed the button to escape — which
 * reads, correctly, as the button doing nothing.
 */
async function resolveAdoptableClaudeCredentials(
  credentials: ClaudeCliCredentials,
): Promise<ClaudeCliCredentials | null> {
  // Live access token: adopt as-is, no network round trip.
  if (claudeAccessTokenIsLive(credentials)) return credentials;

  const refreshToken = credentials.refreshToken;
  if (
    !refreshToken ||
    !isUsableRefreshToken(refreshToken, credentials.accessToken) ||
    !claudeOAuthService
  ) {
    return null;
  }

  // A grant the provider has already refused will be refused again.
  if (refreshRejections.isRejected("anthropic", refreshToken)) return null;

  // Only the access token has lapsed, which is the ordinary state of a Claude
  // Code login left idle for a few hours. Renewing keeps that case off the
  // terminal path — but the credential is adopted on the refresh *succeeding*,
  // never on a refresh token merely being present.
  try {
    const renewed = await claudeOAuthService.refreshToken(refreshToken);
    return {
      accessToken: renewed.accessToken,
      refreshToken: renewed.refreshToken,
      expiresAt: Date.now() + renewed.expiresIn * 1000,
    };
  } catch (error) {
    if (isInvalidGrantError(error)) {
      refreshRejections.record("anthropic", refreshToken);
    }
    console.warn(
      "[OAuth IPC] Claude Code credentials could not be renewed — continuing to sign-in:",
      (error as Error).message,
    );
    return null;
  }
}

async function adoptClaudeCredentialsFromCLIStorage(
  tokenId: string,
  options?: { mustOutliveMs?: number },
): Promise<boolean> {
  if (!oauthTokenStorage || !claudeSetupTokenService) return false;

  const credentials =
    await claudeSetupTokenService.readCredentialsFromCLIStorage();
  if (!credentials) {
    console.warn(
      "[OAuth IPC] Claude token cannot be refreshed and Claude Code has no credentials to adopt — reconnect required",
    );
    return false;
  }

  if (!isUsableRefreshToken(credentials.refreshToken, credentials.accessToken)) {
    // A setup-token has no refresh token to adopt, so there is nothing to
    // improve. Leave the stored record alone.
    return false;
  }

  const describeExpiry = (ms: number | undefined): string =>
    ms === undefined ? "unknown" : new Date(ms).toISOString();

  // Adoption overwrites a credential the user may have just entered by hand, so
  // it has to be an upgrade. Claude Code's stored copy is only authoritative
  // while it is current; once its access token has lapsed, adopting it swaps a
  // working token for a dead one and — because the replacement is expired on
  // arrival — arms the very next refresh tick to do it again.
  if (!claudeAccessTokenIsLive(credentials)) {
    // Lead with whose token is fine. The earlier wording opened with "access
    // token expired" and a date, which reads as an alarm about the token the
    // user is actually using — and the reassuring half was at the end.
    console.warn(
      `[OAuth IPC] Keeping your stored Claude token, which is unaffected. ` +
        `Claude Code's own copy is stale (its access token lapsed ` +
        `${describeExpiry(credentials.expiresAt)}), so there is no live ` +
        `credential to adopt from it. Sign in to Claude Code again if you want ` +
        `it usable as a refresh source.`,
    );
    return false;
  }

  if (
    options?.mustOutliveMs !== undefined &&
    credentials.expiresAt !== undefined &&
    credentials.expiresAt <= options.mustOutliveMs
  ) {
    console.warn(
      `[OAuth IPC] Not adopting Claude Code credentials: they expire ` +
        `${describeExpiry(credentials.expiresAt)}, no later than the stored ` +
        `token (${describeExpiry(options.mustOutliveMs)}).`,
    );
    return false;
  }

  const lifetime = claudeCredentialsToTokenLifetime(credentials, {
    fallbackTtlSeconds: SETUP_TOKEN_ASSUMED_TTL_SECONDS,
  });

  await oauthTokenStorage.updateToken(tokenId, lifetime);
  await syncOAuthTokenToApiKeys("anthropic", lifetime.accessToken);

  console.log(
    `[OAuth IPC] Adopted Claude Code credentials (expires ` +
      `${describeExpiry(credentials.expiresAt)}, refreshable)`,
  );
  return true;
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

    const needsRefreshSoon = oauthTokenStorage.isTokenExpired(
      token,
      REFRESH_BUFFER / 60,
    );

    const canRedeemRefreshToken = isUsableRefreshToken(
      token.refreshToken,
      token.accessToken,
    );

    // Tokens stored by older builds echoed the access token into the refresh
    // slot alongside an invented year-long expiry, so they can neither be
    // refreshed nor ever look expired. Re-reading Claude Code's own storage
    // replaces that copy with the real refresh token and expiry.
    //
    // The check cannot be moved below the expiry test — such a token never
    // looks expired, so this is the only path that ever repairs it. What it can
    // stop being is constant: the repair matters before the token lapses, not
    // sixty times an hour while it is still good for a year. Attempting it once
    // per session (and whenever expiry actually approaches) keeps the repair
    // and drops the Keychain read, and with it a warning about Claude Code's
    // stale copy that fired on a timer while nothing was wrong.
    if (provider === "anthropic" && !canRedeemRefreshToken) {
      if (!needsRefreshSoon && cliAdoptionAttempted.has(provider)) {
        return false;
      }
      cliAdoptionAttempted.add(provider);
      return await adoptClaudeCredentialsFromCLIStorage(token.id);
    }

    if (!needsRefreshSoon) {
      // Token is still valid, no refresh needed.
      return false;
    }

    if (!canRedeemRefreshToken) {
      // A refresh grant only accepts a refresh token; sending the access token
      // would 400. Nothing to do but let the UI ask for a reconnect.
      console.warn(
        `[OAuth IPC] ${provider} token expired but no usable refresh token is stored — reconnect required`,
      );
      return false;
    }

    // A grant the server already answered `invalid_grant` to will be refused
    // identically every time, so re-posting it each tick only produces noise.
    if (refreshRejections.isRejected(provider, token.refreshToken)) {
      console.warn(
        `[OAuth IPC] ${provider} refresh token was already rejected by the provider — reconnect required`,
      );
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

    // Only an explicit `invalid_grant` condemns the token; a Cloudflare
    // challenge or a network fault says nothing about it and stays retryable.
    if (isInvalidGrantError(error)) {
      const rejectedToken =
        oauthTokenStorage?.getTokenByProvider(provider)?.refreshToken;
      if (rejectedToken) refreshRejections.record(provider, rejectedToken);
    }

    // Claude Code keeps its own access token renewed and is the authority for
    // these credentials, so a failed refresh of our copy is recoverable: adopt
    // its current record instead. Previously this path just returned, leaving
    // the stored token expired with nothing that would ever renew it.
    //
    // The stored expiry is passed as the bar to beat. We only reach here after
    // a refresh was rejected, so Claude Code's copy is a candidate, not an
    // authority — adopting one that dies sooner than what we already hold is a
    // downgrade, and adopting an already-dead one is what overwrote tokens the
    // user had just entered by hand.
    if (provider === "anthropic" && oauthTokenStorage) {
      const token = oauthTokenStorage.getTokenByProvider(provider);
      if (token) {
        const storedExpiresAtMs = Date.parse(token.expiresAt);
        const baseline: { mustOutliveMs?: number } = Number.isNaN(
          storedExpiresAtMs,
        )
          ? {}
          : { mustOutliveMs: storedExpiresAtMs };
        try {
          if (await adoptClaudeCredentialsFromCLIStorage(token.id, baseline)) {
            console.log(
              "[OAuth IPC] Recovered from failed refresh by adopting Claude Code credentials",
            );
            return true;
          }
        } catch (adoptError) {
          console.error(
            "[OAuth IPC] Adopting Claude Code credentials also failed:",
            adoptError,
          );
        }
      }
    }

    sendOAuthStatus(
      provider,
      "error",
      error instanceof Error ? error.message : "Token refresh failed",
    );
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
  ipcMain.handle(
    "auth:openai:start-oauth",
    async (_event, options?: OAuthStartTelemetryOptions) => {
      const telemetrySource = resolveOAuthTelemetrySource(options?.source);
    try {
      console.log("[OAuth IPC] Starting OpenAI OAuth flow");
      oauthFlowStartedAt.set("openai", Date.now());
      trackOAuthStep("openai", "flow_started", { source: telemetrySource });

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
        // An expired token that can still be refreshed renews itself on the
        // next request, so the card must not raise an alarm about it. Only one
        // that has expired with no way back needs the user. Without this the
        // UI cannot tell those apart, so it has to either cry wolf or, as it
        // did, stay green while every request was being refused.
        canRenew: tokenCanRenew("openai", token),
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
      refreshRejections.clear("openai");
      cliAdoptionAttempted.delete("openai");

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
  ipcMain.handle(
    "auth:claude:start-oauth",
    async (_event, options?: OAuthStartTelemetryOptions) => {
      const telemetrySource = resolveOAuthTelemetrySource(options?.source);
    try {
      console.log("[OAuth IPC] Starting Claude OAuth flow");
      oauthFlowStartedAt.set("anthropic", Date.now());
      trackOAuthStep("anthropic", "flow_started", { source: telemetrySource });

      // Step 0: Check for existing token in Keychain / credential files.
      // Finding credentials is not the same as their working, so they are only
      // adopted once they demonstrably authenticate — live, or successfully
      // renewed. Anything else falls through to the real sign-in below.
      const existingCredentials =
        await claudeSetupTokenService!.readCredentialsFromCLIStorage();
      const adoptableCredentials = existingCredentials
        ? await resolveAdoptableClaudeCredentials(existingCredentials)
        : null;

      if (existingCredentials && !adoptableCredentials) {
        console.log(
          "[OAuth IPC] Claude CLI credentials cannot authenticate (expired " +
            `${
              existingCredentials.expiresAt === undefined
                ? "unknown"
                : new Date(existingCredentials.expiresAt).toISOString()
            }, not renewable) — continuing to sign-in instead of adopting them`,
        );
      }

      if (adoptableCredentials) {
        console.log("[OAuth IPC] Found existing Claude credentials in CLI storage");
        trackOAuthStep("anthropic", "keychain_token_found", { source: telemetrySource });
        const tokenInput = {
          provider: "anthropic" as const,
          ...claudeCredentialsToTokenLifetime(adoptableCredentials, {
            fallbackTtlSeconds: SETUP_TOKEN_ASSUMED_TTL_SECONDS,
          }),
        };
        await persistOAuthConnection("anthropic", tokenInput, {
          flow_source: "keychain",
          source: telemetrySource,
        });
        return { success: true, source: "keychain" };
      }

      // Step 1: Ensure Claude CLI is installed (uses shell PATH resolution)
      const isInstalled = await claudeSetupTokenService!.isClaudeCLIInstalled();
      if (!isInstalled) {
        console.log("[OAuth IPC] Claude CLI not found, installing...");
        trackOAuthStep("anthropic", "cli_install_started", { source: telemetrySource });
        const installResult = await claudeSetupTokenService!.installClaudeCLI();
        if (!installResult.success) {
          console.error("[OAuth IPC] Failed to install Claude CLI:", installResult.error);
          const message = "Could not install Claude CLI. Use Manual Setup instead.";
          trackOAuthStep("anthropic", "cli_install_failed", {
            source: telemetrySource,
            error: installResult.error,
          });
          trackOAuthFailed("anthropic", message, { stage: "start", source: telemetrySource });
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

      trackOAuthStep("anthropic", "terminal_opened", {
        source: telemetrySource,
        terminal_opened: terminalOpened,
      });

      return { success: true, source: "terminal-opened", terminalOpened };
    } catch (error) {
      console.error("[OAuth IPC] Failed to start Claude OAuth:", error);
      const message = error instanceof Error ? error.message : "Start OAuth failed";
      trackOAuthFailed("anthropic", message, { stage: "start", source: telemetrySource });
      sendOAuthStatus("anthropic", "error", message);
      return {
        success: false,
        error: message,
      };
    }
  },
  );

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
        // An expired token that can still be refreshed renews itself on the
        // next request, so the card must not raise an alarm about it. Only one
        // that has expired with no way back needs the user. Without this the
        // UI cannot tell those apart, so it has to either cry wolf or, as it
        // did, stay green while every request was being refused.
        canRenew: tokenCanRenew("anthropic", token),
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
      refreshRejections.clear("anthropic");
      cliAdoptionAttempted.delete("anthropic");

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

  ipcMain.handle(
    "auth:claude:try-sync-from-storage",
    async (_event, options?: OAuthStartTelemetryOptions) => {
      const telemetrySource = resolveOAuthTelemetrySource(options?.source);
      try {
        const credentials =
          await claudeSetupTokenService!.readCredentialsFromCLIStorage();
        if (!credentials) {
          return { success: false, reason: "not_found" as const };
        }

        // This polls while the user completes sign-in in the terminal, so the
        // stale credential that sign-in is meant to replace is still on disk
        // for most of that window. What we are waiting for is a freshly minted
        // token, and those are live by definition — so liveness is the test.
        // Accepting a merely renewable credential here would let the very first
        // poll adopt the stale one and report success before the user has
        // typed anything, which is the same false success Connect used to give.
        if (!claudeAccessTokenIsLive(credentials)) {
          return { success: false, reason: "not_found" as const };
        }

        if (!oauthFlowStartedAt.has("anthropic")) {
          oauthFlowStartedAt.set("anthropic", Date.now());
        }

        const tokenInput = {
          provider: "anthropic" as const,
          ...claudeCredentialsToTokenLifetime(credentials, {
            fallbackTtlSeconds: SETUP_TOKEN_ASSUMED_TTL_SECONDS,
          }),
        };

        await persistOAuthConnection("anthropic", tokenInput, {
          flow_source: "keychain",
          source: telemetrySource,
        });

        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Sync failed";
        return { success: false, reason: "error" as const, error: message };
      }
    },
  );

  // Claude OAuth: Paste token (alternative to full OAuth flow)
  ipcMain.handle(
    "auth:claude:paste-token",
    async (_event, token: string, options?: OAuthStartTelemetryOptions) => {
      const telemetrySource = resolveOAuthTelemetrySource(options?.source);
    try {
      console.log("[OAuth IPC] Pasting Claude OAuth token");
      if (!oauthFlowStartedAt.has("anthropic")) {
        oauthFlowStartedAt.set("anthropic", Date.now());
      }
      trackOAuthStep("anthropic", "paste_token_submitted", {
        source: telemetrySource,
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

      // A pasted setup-token arrives on its own: no refresh token, no expiry.
      // claudeCredentialsToTokenLifetime echoes the access token into the
      // refresh slot to satisfy storeToken, and isUsableRefreshToken keeps the
      // refresh path from trying to redeem it.
      const tokenInput = {
        provider: "anthropic" as const,
        ...claudeCredentialsToTokenLifetime(
          { accessToken: cleanedToken },
          { fallbackTtlSeconds: SETUP_TOKEN_ASSUMED_TTL_SECONDS },
        ),
      };

      await persistOAuthConnection("anthropic", tokenInput, {
        flow_source: "paste",
        stage: "paste",
        source: telemetrySource,
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
