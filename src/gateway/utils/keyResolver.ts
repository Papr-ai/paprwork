/**
 * Key Resolver - Lazy loading of API keys
 * 
 * In production (packaged app):
 * - Requests keys from Electron main process via IPC (triggers keychain only when needed)
 * 
 * In development:
 * - Falls back to process.env / .env.local
 * 
 * This matches V1's approach - no upfront decryption, only on-demand
 */

let keyCache: Record<string, string> = {};
let requestId = 0;

/**
 * Request keys from main process via IPC (production mode)
 */
async function requestKeysViaIPC(keyNames: string[]): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    if (!process.send) {
      reject(new Error("IPC not available - not running as child process"));
      return;
    }

    const reqId = `keys-${++requestId}`;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Key resolution timeout"));
    }, 5000);

    const messageHandler = (message: { type?: string; requestId?: string; keys?: Record<string, string> }) => {
      if (message.type === "KEYS_RESPONSE" && message.requestId === reqId) {
        cleanup();
        resolve(message.keys || {});
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      process.off("message", messageHandler);
    };

    process.on("message", messageHandler);
    process.send({
      type: "REQUEST_KEYS",
      requestId: reqId,
      keys: keyNames,
    });
  });
}

/**
 * Get API keys (lazy loading)
 * 
 * @param keyNames - Array of key names to fetch
 * @returns Record of key names to values
 */
export async function getApiKeys(keyNames: string[]): Promise<Record<string, string>> {
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
    console.log(`[KeyResolver] Requesting ${uncachedKeys.length} keys from main process`);
    try {
      const resolved = await requestKeysViaIPC(uncachedKeys);
      // Update cache
      Object.assign(keyCache, resolved);
      console.log(`[KeyResolver] Received ${Object.keys(resolved).length} keys`);
    } catch (error) {
      console.error("[KeyResolver] Failed to resolve keys via IPC:", error);
      // Fall back to env vars if IPC fails
      for (const keyName of uncachedKeys) {
        const value = process.env[keyName];
        if (value) {
          keyCache[keyName] = value;
        }
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
  const keys = await getApiKeys([keyName]);
  return keys[keyName];
}

/**
 * Clear the key cache (useful for testing)
 */
export function clearKeyCache(): void {
  keyCache = {};
}
