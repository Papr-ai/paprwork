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
import {
  getActivePaprWorkspacePointer,
  paprApiKeyMatchesActiveWorkspace,
  paprApiKeyMatchesNamespaceBound,
} from "../../core/utils/paprApiKey.js";
import { readActiveWorkspacePointer } from "../../core/utils/paprWorkspace.js";

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
const PAPR_API_KEY_RETRY_COOLDOWN_MS = 3_000;

let paprApiKeyIpcInFlight: Promise<string | undefined> | null = null;
let paprApiKeyUnavailableUntil = 0;

function paprApiKeyMatchesBoundActiveWorkspace(apiKey: string): boolean {
  const pointer =
    getActivePaprWorkspacePointer() ?? readActiveWorkspacePointer();
  if (!pointer) {
    return true;
  }
  return paprApiKeyMatchesNamespaceBound(
    apiKey,
    pointer.organizationId,
    pointer.namespaceId,
  );
}

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

    // A live IPC channel does not mean the parent is the Electron main process.
    // Vitest's forks pool connects one too, and routes anything we post into its
    // own RPC deserializer, which calls Buffer.from() on our plain object,
    // throws ERR_INVALID_ARG_TYPE, and kills the whole run with a stack that
    // names vitest internals rather than this line.
    //
    // Only refuse when we would post to the REAL process — that is vitest's
    // channel. An injected ipcProcess is a test double with its own send/on,
    // which is how the IPC flow itself is tested; blocking that made those
    // tests resolve undefined instead of exercising the path they cover.
    if (
      ipcProcess === process &&
      (process.env.VITEST || process.env.NODE_ENV === "test")
    ) {
      reject(new Error("IPC not available - running under test"));
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
      for (const [keyName, value] of Object.entries(resolved)) {
        if (
          keyName === "PAPR_API_KEY" &&
          !paprApiKeyMatchesBoundActiveWorkspace(value)
        ) {
          console.warn(
            "[KeyResolver] Ignoring IPC PAPR_API_KEY — wrong org/namespace for active workspace",
          );
          continue;
        }
        keyCache[keyName] = value;
      }
      missingAfterIpc = uncachedKeys.filter((keyName) => !keyCache[keyName]);
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
      if (!value) {
        continue;
      }
      if (
        keyName === "PAPR_API_KEY" &&
        !paprApiKeyMatchesActiveWorkspace(value)
      ) {
        console.warn(
          "[KeyResolver] Ignoring PAPR_API_KEY env fallback — wrong org/namespace for active workspace",
        );
        continue;
      }
      keyCache[keyName] = value;
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
 * Papr cloud identity key — always prefer Papr login (keychain via IPC) over .env.local.
 * Used for cloud sync, Turso, memory server proxy, Composer.
 */
async function resolvePaprApiKeyViaIpc(
  ipcProcess: IpcProcessLike,
): Promise<string | undefined> {
  try {
      const keys = await requestKeysViaIPC(["PAPR_API_KEY"], ipcProcess);
      if (keys.PAPR_API_KEY?.trim()) {
        const resolved = keys.PAPR_API_KEY.trim();
        if (!paprApiKeyMatchesBoundActiveWorkspace(resolved)) {
          console.warn(
            "[KeyResolver] IPC returned PAPR_API_KEY for wrong org/namespace — omitting until namespace key sync completes",
          );
          return undefined;
        }
        keyCache.PAPR_API_KEY = resolved;
        paprApiKeyUnavailableUntil = 0;
        return resolved;
      }
  } catch (error) {
    console.warn(
      "[KeyResolver] PAPR_API_KEY IPC lookup failed:",
      (error as Error).message,
    );
    paprApiKeyUnavailableUntil = Date.now() + PAPR_API_KEY_RETRY_COOLDOWN_MS;
  }

  return undefined;
}

export async function getPaprApiKey(
  ipcProcess: IpcProcessLike = process,
): Promise<string | undefined> {
  // Main process is authoritative for Papr login keys (namespace vault slots).
  const cached = keyCache.PAPR_API_KEY?.trim();
  if (cached) {
    if (paprApiKeyMatchesBoundActiveWorkspace(cached)) {
      return cached;
    }
    console.warn(
      "[KeyResolver] Clearing stale cached PAPR_API_KEY — wrong org/namespace for active workspace",
    );
    delete keyCache.PAPR_API_KEY;
  }

  if (Date.now() < paprApiKeyUnavailableUntil) {
    return undefined;
  }

  if (ipcProcess.send) {
    if (!paprApiKeyIpcInFlight) {
      paprApiKeyIpcInFlight = resolvePaprApiKeyViaIpc(ipcProcess).finally(() => {
        paprApiKeyIpcInFlight = null;
      });
    }
    const fromIpc = await paprApiKeyIpcInFlight;
    if (fromIpc) {
      return fromIpc;
    }
  }

  const envKey = process.env.PAPR_API_KEY?.trim();
  if (envKey && paprApiKeyMatchesActiveWorkspace(envKey)) {
    return envKey;
  }
  if (envKey) {
    console.warn(
      "[KeyResolver] Ignoring PAPR_API_KEY from env — scoped to a different org/namespace than the active workspace",
    );
  }

  return undefined;
}

/**
 * Clear the key cache (useful for testing or when keys are updated)
 * @param keyName - Optional specific key to clear, or undefined to clear all
 */
export function clearKeyCache(keyName?: string): void {
  if (keyName) {
    delete keyCache[keyName];
    if (keyName === "PAPR_API_KEY") {
      paprApiKeyUnavailableUntil = 0;
    }
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

/**
 * Resolve auth for a specific model. Some models (e.g. gpt-5.3-codex) are retired
 * on ChatGPT OAuth and require a Platform API key even when OAuth is connected.
 */
export async function getProviderAuthForModel(
  provider: "openai" | "anthropic",
  options: { modelId: string; modelProvider: string },
  ipcProcess: IpcProcessLike = process,
): Promise<
  { type: "oauth"; token: string } | { type: "apiKey"; key: string } | null
> {
  const { modelId, modelProvider } = options;

  if (provider === "openai") {
    const { requiresOpenAIPlatformApiKey } =
      await import("./modelNormalizer.js");
    if (
      requiresOpenAIPlatformApiKey(modelId) &&
      (modelProvider === "openai-codex" || modelProvider === "openai")
    ) {
      const keys = await getApiKeys(["OPENAI_API_KEY"], ipcProcess);
      if (keys.OPENAI_API_KEY) {
        console.log(
          `[KeyResolver] ${modelId} requires Platform API key — using OPENAI_API_KEY`,
        );
        return { type: "apiKey", key: keys.OPENAI_API_KEY };
      }
      console.log(
        `[KeyResolver] ${modelId} is not available via ChatGPT OAuth and no OPENAI_API_KEY found`,
      );
      return null;
    }
  }

  return getProviderAuth(provider, ipcProcess);
}
