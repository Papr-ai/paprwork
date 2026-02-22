/**
 * Key Resolver - Lazy loading of API keys
 *
 * In production (packaged app):
 * - Requests keys from Electron main process via IPC (triggers keychain only when needed)
 * - Includes OAuth tokens if available (prioritized over API keys)
 *
 * In development:
 * - Falls back to process.env / .env.local
 *
 * This matches V1's approach - no upfront decryption, only on-demand
 */

import type { RequestKeysMessage } from "../../core/types/gateway-ipc.js";
import { isKeysResponseMessage } from "../../core/types/gateway-ipc.js";

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
    }, 5000);

    const messageHandler = (message: unknown) => {
      if (isKeysResponseMessage(message) && message.requestId === reqId) {
        cleanup();
        // Cache OAuth tokens if available
        if (message.oauthTokens) {
          oauthTokenCache = message.oauthTokens;
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
 * Clear the key cache (useful for testing)
 */
export function clearKeyCache(): void {
  keyCache = {};
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
): Promise<
  { type: "oauth"; token: string } | { type: "apiKey"; key: string } | null
> {
  const keyName =
    provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";

  // Request keys first - IPC response populates oauthTokenCache when main process sends oauthTokens
  const keys = await getApiKeys([keyName]);

  // Now check OAuth (cache populated by IPC response above)
  if (hasValidOAuthToken(provider)) {
    const token = getOAuthToken(provider);
    if (token) {
      console.log(`[KeyResolver] Using OAuth token for ${provider}`);
      return { type: "oauth", token: token.accessToken };
    }
  }

  // Fall back to API key
  if (keys[keyName]) {
    console.log(`[KeyResolver] Using API key for ${provider}`);
    return { type: "apiKey", key: keys[keyName] };
  }

  console.log(`[KeyResolver] No authentication found for ${provider}`);
  return null;
}
