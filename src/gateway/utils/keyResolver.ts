/**
 * Key Resolver - Lazy loading of API keys
 *
 * In production (packaged app):
 * - Requests keys from Electron main process via IPC (triggers keychain only when needed)
 * - Includes OAuth tokens if available (prioritized over API keys)
 * - Listens for cache invalidation messages when keys are updated
 *
 * In development:
 * - Falls back to process.env / .env.local
 *
 * This matches V1's approach - no upfront decryption, only on-demand
 */

import type { RequestKeysMessage } from "../../core/types/gateway-ipc.js";
import {
  isKeysResponseMessage,
  isInvalidateKeyCacheMessage,
} from "../../core/types/gateway-ipc.js";

let keyCache: Record<string, string> = {};
let oauthTokenCache: {
  openai?: { accessToken: string; expiresAt: string };
  anthropic?: { accessToken: string; expiresAt: string };
} = {};
let requestId = 0;

interface IpcProcessLike {
  send?: (message: unknown) => void;
  on: (event: "message", listener: (message: unknown) => void) => void;
  off: (event: "message", listener: (message: unknown) => void) => void;
}

const IPC_KEY_RESOLVE_TIMEOUT_MS = 15_000;

/**
 * Request keys from main process via IPC.
 * Used for Settings custom keys and provider keys (works in dev + prod when gateway is an Electron child).
 */
export async function resolveKeysViaIpc(
  keyNames: string[],
  ipcProcess: IpcProcessLike = process,
): Promise<Record<string, string>> {
  return requestKeysViaIPC(keyNames, ipcProcess);
}

/**
 * Request keys from main process via IPC (production mode)
 */
async function requestKeysViaIPC(
  keyNames: string[],
  ipcProcess: IpcProcessLike,
): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    if (!ipcProcess.send) {
      reject(new Error("IPC not available - not running as child process"));
      return;
    }

    const reqId = `keys-${++requestId}`;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Key resolution timeout"));
    }, IPC_KEY_RESOLVE_TIMEOUT_MS);

    const messageHandler = (message: unknown) => {
      if (isKeysResponseMessage(message) && message.requestId === reqId) {
        cleanup();
        // Main is authoritative: when it includes `oauthTokens`, replace cache (including `{}`
        // when no valid subscription tokens) so we never keep a stale accessToken after re-auth.
        if ("oauthTokens" in message) {
          oauthTokenCache = message.oauthTokens ?? {};
        }
        resolve(message.keys || {});
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      ipcProcess.off("message", messageHandler);
    };

    ipcProcess.on("message", messageHandler);
    const payload: RequestKeysMessage = {
      type: "REQUEST_KEYS",
      requestId: reqId,
      keys: keyNames,
    };
    ipcProcess.send(payload);
  });
}

/**
 * Get API keys (lazy loading)
 *
 * @param keyNames - Array of key names to fetch
 * @returns Record of key names to values
 */
export async function getApiKeys(
  keyNames: string[],
  ipcProcess: IpcProcessLike = process,
): Promise<Record<string, string>> {
  const isDev = process.env.NODE_ENV === "development";
  const keys: Record<string, string> = {};

  if (isDev) {
    // Development: use process.env (from .env.local)
    console.log("[KeyResolver] Development mode - using process.env");
    for (const keyName of keyNames) {
      const value = process.env[keyName];
      if (value) {
        keys[keyName] = value;
        console.log(`[KeyResolver]   ✓ ${keyName} found in env`);
      }
    }
    return keys;
  }

  // Production: check cache first
  const uncachedKeys = keyNames.filter((name) => !keyCache[name]);

  if (uncachedKeys.length > 0) {
    console.log(
      `[KeyResolver] Requesting ${uncachedKeys.length} keys from main process`,
    );

    let missingAfterIpc = uncachedKeys;
    try {
      const resolved = await requestKeysViaIPC(uncachedKeys, ipcProcess);
      Object.assign(keyCache, resolved);
      missingAfterIpc = uncachedKeys.filter((keyName) => !resolved[keyName]);
      console.log(
        `[KeyResolver] Received ${Object.keys(resolved).length} keys`,
      );
      
      // Trigger lazy code indexing if PAPR_API_KEY was just resolved
      if (resolved.PAPR_API_KEY) {
        console.log('[KeyResolver] PAPR_API_KEY resolved, triggering code indexing...');
        const { ensureIndexingStarted } = await import('../services/CodeIndexingService.js');
        ensureIndexingStarted(resolved.PAPR_API_KEY).catch((error) => {
          console.error('[KeyResolver] Failed to start code indexing:', error);
        });
      }
    } catch (error) {
      console.error("[KeyResolver] Failed to resolve keys via IPC:", error);
    }

    // Fall back to env vars for unresolved keys.
    // This keeps development usable while still preferring secure IPC lookups.
    for (const keyName of missingAfterIpc) {
      const value = process.env[keyName];
      if (value) {
        keyCache[keyName] = value;
      }
    }
  }

  // Return requested keys from cache
  for (const keyName of keyNames) {
    if (keyCache[keyName]) {
      keys[keyName] = keyCache[keyName];
    }
  }

  return keys;
}

/**
 * Get a single API key
 */
export async function getApiKey(keyName: string): Promise<string | undefined> {
  const keys = await getApiKeys([keyName], process);
  return keys[keyName];
}

/**
 * Clear the key cache (useful for testing or when keys are updated)
 * @param keyName - Optional specific key to clear, or undefined to clear all
 */
export function clearKeyCache(keyName?: string): void {
  if (keyName) {
    delete keyCache[keyName];
    if (keyName === "OPENAI_API_KEY") {
      delete oauthTokenCache.openai;
    } else if (keyName === "ANTHROPIC_API_KEY") {
      delete oauthTokenCache.anthropic;
    }
    console.log(`[KeyResolver] Cleared cache for key: ${keyName}`);
  } else {
    keyCache = {};
    oauthTokenCache = {};
    console.log("[KeyResolver] Cleared entire key cache");
  }
}

/**
 * Set up listener for cache invalidation messages from Electron
 * This should be called once during Gateway initialization
 */
export function setupKeyCacheInvalidationListener(
  ipcProcess: IpcProcessLike = process,
): void {
  const messageHandler = (message: unknown) => {
    if (isInvalidateKeyCacheMessage(message)) {
      console.log(
        "[KeyResolver] Received cache invalidation:",
        message.keyName || "all keys",
      );
      clearKeyCache(message.keyName);
    }
  };

  ipcProcess.on("message", messageHandler);
  console.log("[KeyResolver] Cache invalidation listener registered");
}

/**
 * Get OAuth token for a provider (if available)
 */
export function getOAuthToken(
  provider: "openai" | "anthropic",
): { accessToken: string; expiresAt: string } | undefined {
  return oauthTokenCache[provider];
}

/**
 * Check if OAuth token is available and not expired
 */
export function hasValidOAuthToken(provider: "openai" | "anthropic"): boolean {
  const token = oauthTokenCache[provider];
  if (!token) return false;

  const expiresAt = new Date(token.expiresAt).getTime();
  const now = Date.now();
  const buffer = 5 * 60 * 1000; // 5 minutes buffer

  return now < expiresAt - buffer;
}

/**
 * Get authentication for a provider (prioritizes OAuth over API key)
 * Returns { type: 'oauth', token } or { type: 'apiKey', key } or null
 */
export async function getProviderAuth(
  provider: "openai" | "anthropic",
  ipcProcess: IpcProcessLike = process,
): Promise<
  { type: "oauth"; token: string } | { type: "apiKey"; key: string } | null
> {
  const keyName =
    provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";

  // Populate OAuth cache from Electron main process when available.
  // In dev mode getApiKeys() reads process.env only, but the gateway still runs
  // as an Electron child with IPC — so OAuth tokens from Settings must be loaded here.
  if (ipcProcess.send && !hasValidOAuthToken(provider)) {
    try {
      await requestKeysViaIPC([keyName], ipcProcess);
    } catch (error) {
      console.warn(
        `[KeyResolver] OAuth IPC lookup failed for ${provider}:`,
        (error as Error).message,
      );
    }
  }

  // Request keys (env in dev, IPC cache in prod)
  const keys = await getApiKeys([keyName], ipcProcess);

  // Now check OAuth (cache populated by IPC response above)
  if (hasValidOAuthToken(provider)) {
    const token = getOAuthToken(provider);
    if (token) {
      console.log(
        `[KeyResolver] Using OAuth token for ${provider} ` +
        `(length: ${token.accessToken.length}, prefix: ${token.accessToken.substring(0, 20)}...)`
      );
      return { type: "oauth", token: token.accessToken };
    }
  }

  // Fall back to API key
  if (keys[keyName]) {
    console.log(
      `[KeyResolver] Using API key for ${provider} ` +
      `(length: ${keys[keyName].length}, prefix: ${keys[keyName].substring(0, 20)}...)`
    );
    return { type: "apiKey", key: keys[keyName] };
  }

  console.log(`[KeyResolver] No authentication found for ${provider}`);
  return null;
}
