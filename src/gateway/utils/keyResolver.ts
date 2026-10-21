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
  parsePaprApiKeyScope,
} from "../../core/utils/paprApiKey.js";
import { readActiveWorkspacePointer } from "../../core/utils/paprWorkspace.js";

let keyCache: Record<string, string> = {};
/** Names already asked of main this session, including misses — don't re-IPC. */
const ipcAskedNames = new Set<string>();
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
 * Above this, a key IPC round trip is worth a line in the log. A local pipe hop
 * plus a keychain read is microseconds (measured: ~0.6µs per safeStorage decrypt),
 * so anything near a second means time was spent somewhere other than the work.
 */
const SLOW_IPC_ROUND_TRIP_MS = 1_000;
const PAPR_API_KEY_RETRY_COOLDOWN_MS = 3_000;
/** Re-read OAuth vs API-key decision from main without keychain on every agent turn. */
const OAUTH_IPC_REFRESH_TTL_MS = 8_000;
let oauthIpcLastRefreshAtMs = 0;

/** Coalesce concurrent IPC key requests (tab switch can fan out several getProviderAuth calls). */
const inFlightKeyRequests = new Map<string, Promise<Record<string, string>>>();

/**
 * Real Platform keys that the OAuth path overwrote in process.env.
 *
 * pi-ai reads its credential from process.env, so an OAuth turn assigns the
 * OAuth token to ANTHROPIC_API_KEY / OPENAI_API_KEY for the rest of the process.
 * Without the original stashed here, switching a provider back to its API key
 * would resolve that OAuth token instead of the user's real key.
 */
const overwrittenEnvKeys: Record<string, string> = {};

/**
 * Bumped whenever the cached credentials change — auth-mode switch, key edit,
 * re-auth. Chat sessions keep the credential they resolved at creation for their
 * whole lifetime, so they compare epochs to notice theirs went stale.
 */
let authEpoch = 0;

export function getAuthEpoch(): number {
  return authEpoch;
}

/**
 * OAuth access tokens are not Platform API keys — sending one to the Platform
 * API fails or bills against the wrong quota, so never resolve one as a key.
 */
function isOAuthShapedToken(value: string): boolean {
  return value.startsWith("sk-ant-oat") || value.startsWith("sk-ant-ort");
}

/**
 * Call before assigning an OAuth token to a provider's API-key env var so the
 * real key stays resolvable. No-op unless it would discard a genuine key.
 */
export function preserveEnvKeyBeforeOverwrite(keyName: string): void {
  const current = process.env[keyName];
  if (!current || isOAuthShapedToken(current)) return;
  if (overwrittenEnvKeys[keyName]) return;
  overwrittenEnvKeys[keyName] = current;
}

let paprApiKeyIpcInFlight: Promise<string | undefined> | null = null;
let paprApiKeyUnavailableUntil = 0;

/**
 * Namespace the cached PAPR_API_KEY was resolved FOR — the active namespace when
 * the request was sent, not when the answer arrived. Legacy keys carry no
 * namespace in the string, so this is the only thing that ties them to a
 * workspace. Without it a legacy key from the previous workspace passed every
 * check after a switch (Oct 20: 85ZIB7mD1V key used for XHqOmymyGP).
 */
let paprApiKeyBoundNamespace: string | null = null;
/** Bumped whenever PAPR_API_KEY is cleared; answers to older requests are dropped. */
let paprApiKeyEpoch = 0;

function activeNamespaceIdForKeys(): string | null {
  const pointer =
    getActivePaprWorkspacePointer() ?? readActiveWorkspacePointer();
  return pointer?.namespaceId?.trim() || null;
}

function cachePaprApiKey(value: string, boundNamespace: string | null): void {
  keyCache.PAPR_API_KEY = value;
  paprApiKeyBoundNamespace = boundNamespace;
}

/** Cached key still belongs to the active workspace (scoped or legacy). */
function cachedPaprApiKeyStillBound(value: string): boolean {
  if (!paprApiKeyMatchesBoundActiveWorkspace(value)) return false;
  if (parsePaprApiKeyScope(value)) return true; // namespace is in the key itself
  const active = activeNamespaceIdForKeys();
  if (!active) return true;
  return paprApiKeyBoundNamespace === active;
}

/** Namespace the cached PAPR_API_KEY belongs to (embedded, else the bound one). */
export function getCachedPaprApiKeyNamespace(): string | null {
  const cached = keyCache.PAPR_API_KEY?.trim();
  if (!cached) return null;
  return parsePaprApiKeyScope(cached)?.namespaceId ?? paprApiKeyBoundNamespace;
}

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
  // PAPR_API_KEY requests are per key-epoch: after a switch clears the key, a
  // new caller must not join a request sent for the previous workspace.
  const dedupeKey =
    [...keyNames].sort().join(",") +
    (keyNames.includes("PAPR_API_KEY") ? `#papr${paprApiKeyEpoch}` : "");
  const inFlight = inFlightKeyRequests.get(dedupeKey);
  if (inFlight) {
    return inFlight;
  }

  const promise = new Promise<Record<string, string>>((resolve, reject) => {
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
    const sentAt = Date.now();
    const sentNamespace = activeNamespaceIdForKeys();
    const sentPaprEpoch = paprApiKeyEpoch;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Key resolution timeout"));
    }, IPC_KEY_RESOLVE_TIMEOUT_MS);

    const messageHandler = (message: unknown) => {
      if (isKeysResponseMessage(message) && message.requestId === reqId) {
        cleanup();
        // Round trip for a local IPC hop and a keychain read should be single-digit
        // milliseconds. When it is not, this plus main's own "handled in Xms" line
        // says which side the time went: a long round trip against a short handler
        // means the message sat in main's queue, i.e. its event loop was blocked.
        const elapsedMs = Date.now() - sentAt;
        if (elapsedMs >= SLOW_IPC_ROUND_TRIP_MS) {
          console.warn(
            `[KeyResolver] Slow key IPC: ${elapsedMs}ms round trip for ` +
              `${keyNames.join(",")} (${reqId})`,
          );
        }
        // Main is authoritative: when it includes `oauthTokens`, replace cache (including `{}`
        // when no valid subscription tokens) so we never keep a stale accessToken after re-auth.
        if ("oauthTokens" in message) {
          oauthTokenCache = message.oauthTokens ?? {};
        }
        const received = { ...(message.keys || {}) };
        // Main answered for the workspace that was active when we ASKED. If a
        // switch (or key change) happened while the request was in flight, that
        // answer belongs to the old workspace — drop it rather than cache it.
        const nowNamespace = activeNamespaceIdForKeys();
        const answeredFor = message.paprApiKeyNamespaceId?.trim() || null;
        if (
          received.PAPR_API_KEY &&
          (paprApiKeyEpoch !== sentPaprEpoch ||
            nowNamespace !== sentNamespace ||
            (answeredFor !== null && nowNamespace !== null && answeredFor !== nowNamespace))
        ) {
          console.warn(
            `[KeyResolver] Dropping PAPR_API_KEY answer for ${sentNamespace ?? "?"} — workspace changed while ${reqId} was in flight`,
          );
          delete received.PAPR_API_KEY;
        }
        for (const name of keyNames) {
          ipcAskedNames.add(name);
        }
        for (const [keyName, value] of Object.entries(received)) {
          if (!value || isOAuthShapedToken(value)) continue;
          if (keyName === "PAPR_API_KEY") {
            if (!paprApiKeyMatchesBoundActiveWorkspace(value)) continue;
            cachePaprApiKey(value, answeredFor ?? sentNamespace);
            continue;
          }
          keyCache[keyName] = value;
        }
        resolve(received);
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
  }).finally(() => {
    inFlightKeyRequests.delete(dedupeKey);
  });

  inFlightKeyRequests.set(dedupeKey, promise);
  return promise;
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
  const keys: Record<string, string> = {};

  // Settings / keychain via IPC wins over process.env in both dev and prod.
  // `npm start` sets NODE_ENV=development, so the old env-only shortcut meant
  // a key pasted in Settings was never the one sent to Anthropic — .env was.
  const uncachedKeys = keyNames.filter(
    (name) => !keyCache[name] && !ipcAskedNames.has(name),
  );

  if (uncachedKeys.length > 0) {
    console.log(
      `[KeyResolver] Requesting ${uncachedKeys.length} keys from main process`,
    );

    try {
      const resolved = await requestKeysViaIPC(uncachedKeys, ipcProcess);
      for (const [keyName, value] of Object.entries(resolved)) {
        if (!value) continue;
        if (isOAuthShapedToken(value)) {
          console.warn(
            `[KeyResolver]   ✗ Ignoring IPC ${keyName} — holds an OAuth token, not a Platform API key`,
          );
          continue;
        }
        if (
          keyName === "PAPR_API_KEY" &&
          !paprApiKeyMatchesBoundActiveWorkspace(value)
        ) {
          console.warn(
            "[KeyResolver] Ignoring IPC PAPR_API_KEY — wrong org/namespace for active workspace",
          );
          continue;
        }
        // PAPR_API_KEY is cached (with its namespace binding) by the IPC handler.
        if (keyName === "PAPR_API_KEY") continue;
        keyCache[keyName] = value;
      }
      console.log(
        `[KeyResolver] Received ${Object.keys(resolved).length} keys from Settings`,
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

  }

  // Env is fallback only — never overrides a Settings key already in cache.
  // Also runs when IPC already answered "not present" (ipcAskedNames).
  for (const keyName of keyNames) {
    if (
      keyName === "PAPR_API_KEY" &&
      keyCache.PAPR_API_KEY &&
      !cachedPaprApiKeyStillBound(keyCache.PAPR_API_KEY)
    ) {
      delete keyCache.PAPR_API_KEY;
      paprApiKeyBoundNamespace = null;
    }
    if (keyCache[keyName]) {
      keys[keyName] = keyCache[keyName];
      continue;
    }
    const value = overwrittenEnvKeys[keyName] ?? process.env[keyName];
    if (!value) continue;
    if (isOAuthShapedToken(value)) {
      console.warn(
        `[KeyResolver]   ✗ Ignoring ${keyName} — holds an OAuth token, not a Platform API key`,
      );
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
    if (keyName === "PAPR_API_KEY") {
      cachePaprApiKey(value, activeNamespaceIdForKeys());
    } else {
      keyCache[keyName] = value;
    }
    keys[keyName] = value;
    console.log(`[KeyResolver]   ✓ ${keyName} found in env`);
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
        // Handler cached it with its namespace binding (or dropped it as stale).
        if (keyCache.PAPR_API_KEY?.trim() !== resolved) {
          return undefined;
        }
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

/** Shown when chat needs cloud access but no BYOK/OAuth and no Papr login key. */
export const PAPR_PROXY_SIGN_IN_MESSAGE =
  "Sign in with Papr to use cloud models without your own API keys (Settings → AI Models → Login with Papr), or add a provider API key / connect OAuth.";

/**
 * Resolve Papr AI proxy credentials (keychain in prod, IPC + env in dev).
 * Prefer this over getApiKeys(["PAPR_API_KEY"]) — it validates the key against
 * the active workspace before returning.
 */
export async function resolvePaprProxyAuth(
  ipcProcess: IpcProcessLike = process,
): Promise<{ apiKey: string; usePaprProxy: true } | null> {
  const paprApiKey = await getPaprApiKey(ipcProcess);
  if (!paprApiKey) {
    return null;
  }
  return { apiKey: paprApiKey, usePaprProxy: true };
}

export async function getPaprApiKey(
  ipcProcess: IpcProcessLike = process,
): Promise<string | undefined> {
  // Main process is authoritative for Papr login keys (namespace vault slots).
  const cached = keyCache.PAPR_API_KEY?.trim();
  if (cached) {
    if (cachedPaprApiKeyStillBound(cached)) {
      return cached;
    }
    console.warn(
      "[KeyResolver] Clearing stale cached PAPR_API_KEY — resolved for a different workspace",
    );
    delete keyCache.PAPR_API_KEY;
    paprApiKeyBoundNamespace = null;
  }

  if (Date.now() < paprApiKeyUnavailableUntil) {
    return undefined;
  }

  if (ipcProcess.send) {
    if (!paprApiKeyIpcInFlight) {
      const pending: Promise<string | undefined> = resolvePaprApiKeyViaIpc(
        ipcProcess,
      ).finally(() => {
        // clearKeyCache may have replaced it with a request for the new workspace.
        if (paprApiKeyIpcInFlight === pending) paprApiKeyIpcInFlight = null;
      });
      paprApiKeyIpcInFlight = pending;
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
 * Child processes (publish worker) have no IPC channel to Electron main. The
 * gateway resolves the key over IPC and hands it over; seed it as if it came
 * from IPC so it gets the same workspace-binding check, not the stricter
 * untrusted-.env check (which rejects legacy-bound keys).
 */
export function seedPaprApiKeyFromParent(apiKey: string): boolean {
  const trimmed = apiKey.trim();
  if (!trimmed || !paprApiKeyMatchesBoundActiveWorkspace(trimmed)) {
    return false;
  }
  cachePaprApiKey(trimmed, activeNamespaceIdForKeys());
  paprApiKeyUnavailableUntil = 0;
  return true;
}

/**
 * Clear the key cache (useful for testing or when keys are updated)
 * @param keyName - Optional specific key to clear, or undefined to clear all
 */
export function clearKeyCache(keyName?: string): void {
  authEpoch += 1;
  oauthIpcLastRefreshAtMs = 0;
  void import("./cloudSchedulerAuthority.js")
    .then(({ clearCloudSchedulerAuthorityCache }) => {
      clearCloudSchedulerAuthorityCache();
    })
    .catch(() => undefined);
  if (!keyName || keyName === "PAPR_API_KEY") {
    paprApiKeyEpoch += 1;
    paprApiKeyBoundNamespace = null;
    // A request still in flight belongs to the old key/workspace — don't join it.
    paprApiKeyIpcInFlight = null;
  }
  if (keyName) {
    delete keyCache[keyName];
    ipcAskedNames.delete(keyName);
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
    ipcAskedNames.clear();
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
 * Do we already hold something this provider could authenticate with?
 *
 * The distinction this draws is "re-checking what main thinks" versus "we have no
 * credential at all", and only the second is worth making a caller wait for. Both
 * shapes count: on the OAuth route main withholds the API key entirely, so
 * keyCache is empty and the token is the credential; on the API-key route the
 * reverse.
 */
function hasCachedCredentialFor(
  provider: "openai" | "anthropic",
  keyName: string,
): boolean {
  return hasValidOAuthToken(provider) || Boolean(keyCache[keyName]);
}

/**
 * Get authentication for a provider (prioritizes OAuth over API key)
 * Returns { type: 'oauth', token } or { type: 'apiKey', key } or null
 */
export async function getProviderAuth(
  provider: "openai" | "anthropic",
  ipcProcess: IpcProcessLike = process,
): Promise<
  | { type: "oauth"; token: string }
  | { type: "apiKey"; key: string; oauthExpired?: boolean }
  | null
> {
  const keyName =
    provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";

  // Populate OAuth cache from Electron main process when available.
  // In dev mode getApiKeys() reads process.env only, but the gateway still runs
  // as an Electron child with IPC — so OAuth tokens from Settings must be loaded here.
  //
  // Main decides which credentials the gateway may see (withholds OAuth when the
  // user picked API key), so the gateway re-asks on a short TTL.
  //
  // That refresh is a BACKSTOP, not the mechanism. Main pushes
  // INVALIDATE_KEY_CACHE on every credential change — auth-mode toggle, OAuth
  // refresh, key add/edit/delete — and clearKeyCache drops the cached token and
  // zeroes this TTL, so a switch always lands on the cold path below with nothing
  // in hand. The TTL only catches whatever a push missed.
  //
  // Which is why a caller already holding a usable credential must not *wait* for
  // it. Blocking up to IPC_KEY_RESOLVE_TIMEOUT_MS to re-learn something we already
  // have, and then falling back to that same cached value when the wait fails, is
  // pure dead time — and it sits on the hot path of every agent turn and every
  // file the code indexer summarizes.
  const oauthIpcStale =
    Date.now() - oauthIpcLastRefreshAtMs >= OAUTH_IPC_REFRESH_TTL_MS;
  if (ipcProcess.send && oauthIpcStale) {
    // Stamp the attempt, not the success. This used to be advanced only after a
    // resolved request, so while main was slow every subsequent call still found
    // the TTL stale and paid the full timeout again, back to back, for as long as
    // main stayed slow. An attempt that failed is still an attempt.
    oauthIpcLastRefreshAtMs = Date.now();

    const refresh = requestKeysViaIPC([keyName], ipcProcess).catch(
      (error: unknown) => {
        console.warn(
          `[KeyResolver] OAuth IPC lookup failed for ${provider}:`,
          error instanceof Error ? error.message : error,
        );
        return undefined;
      },
    );

    if (hasCachedCredentialFor(provider, keyName)) {
      // Let it land in the cache behind us; the next call picks it up.
      void refresh;
    } else {
      // Nothing cached: this call genuinely has no answer without main.
      await refresh;
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

  // Fall back to API key (or vault OAuth token on cloud agent gateway).
  //
  // When an OAuth token exists but has expired, this is a downgrade rather
  // than a plain fallback: it moves the request off the user's subscription
  // and onto their platform API organisation, which bills separately and
  // carries its own spend caps. Say so out loud. Doing it silently is how a
  // subscription sitting at 11% usage produced "you have reached your usage
  // limits" — the cap being reported belonged to an account the user had not
  // chosen to spend from.
  const oauthExpired = oauthTokenCache[provider] !== undefined;

  if (keys[keyName]) {
    if (process.env.GATEWAY_MODE === "cloud_agent") {
      const { resolveCloudGatewayProviderAuthFromEnvToken } = await import(
        "../services/cloudAgentGateway/resolveCloudProviderAuth.js"
      );
      const reconciled = resolveCloudGatewayProviderAuthFromEnvToken({
        provider,
        token: keys[keyName],
      });
      if (reconciled.authType === "oauth") {
        console.log(
          `[KeyResolver] Cloud vault auth for ${provider}: oauth ` +
            `(length: ${reconciled.token.length}, prefix: ${reconciled.token.substring(0, 20)}...)`,
        );
        return { type: "oauth", token: reconciled.token };
      }
      console.log(
        `[KeyResolver] Cloud vault auth for ${provider}: apiKey ` +
          `(length: ${reconciled.token.length}, prefix: ${reconciled.token.substring(0, 20)}...)`,
      );
      return { type: "apiKey", key: reconciled.token };
    }

    if (oauthExpired) {
      console.warn(
        `[KeyResolver] ${provider} OAuth token is expired — falling back to the ` +
          `platform API key. Requests will bill the platform API account, not ` +
          `the subscription. Reconnect ${provider} in Settings to go back to ` +
          `the subscription.`
      );
    }
    console.log(
      `[KeyResolver] Using API key for ${provider} ` +
        `(length: ${keys[keyName].length}, prefix: ${keys[keyName].substring(0, 20)}...)`,
    );
    return {
      type: "apiKey",
      key: keys[keyName],
      ...(oauthExpired ? { oauthExpired: true } : {}),
    };
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
  | { type: "oauth"; token: string }
  | { type: "apiKey"; key: string; oauthExpired?: boolean }
  | null
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
