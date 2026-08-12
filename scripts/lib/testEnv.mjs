/**
 * Shared env loading for manual / E2E test scripts.
 * Resolves Papr Memory access from (in order):
 *   1. PAPR_API_KEY in process.env / .env.local
 *   2. Papr Work secure storage (same app identity as login)
 *   3. Local gateway proxy (localhost:18789) when Papr Work is running
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Load `.env.local` into process.env (does not override existing vars). */
export function loadEnvLocal(cwd = process.cwd()) {
  try {
    const raw = readFileSync(join(cwd, ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    /* optional */
  }
}

/** @param {string} name */
export function requireEnv(name) {
  loadEnvLocal();
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`❌ ${name} required`);
    console.error(`   Set in .env.local or: export ${name}="..."`);
    process.exit(1);
  }
  return value;
}

/** Sync resolver — env / .env.local only (legacy callers). */
export function requirePaprApiKey() {
  return requireEnv("PAPR_API_KEY");
}

/**
 * Read PAPR_API_KEY from Papr Work secure storage via a short-lived Electron subprocess.
 * Note: keys encrypted by the installed Papr Work.app cannot be decrypted by dev Electron;
 * use resolveMemoryAccess() gateway fallback when the app is running.
 */
export async function resolvePaprApiKeyFromKeychain(cwd = process.cwd()) {
  const electronBin = join(cwd, "node_modules", ".bin", "electron");
  const helper = join(cwd, "scripts", "lib", "read-papr-key-keychain.mjs");

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  try {
    const { stdout } = await execFileAsync(electronBin, [helper], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    const key = stdout.trim();
    return key.startsWith("sk-") ? key : null;
  } catch (error) {
    const err = /** @type {NodeJS.ErrnoException & { code?: number | string }} */ (
      error
    );
    if (err.code === 2) {
      return null;
    }
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[testEnv] Keychain lookup failed: ${detail}`);
    return null;
  }
}

/**
 * Read Parse session + user id from Papr Work secure storage (Electron subprocess).
 * @returns {Promise<{ sessionToken: string, userId: string, displayName?: string, profileImage?: string, source: string } | null>}
 */
export async function resolvePaprSessionFromKeychain(cwd = process.cwd()) {
  const electronBin = join(cwd, "node_modules", ".bin", "electron");
  const helper = join(cwd, "scripts", "lib", "read-papr-session-keychain.mjs");

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  try {
    const { stdout } = await execFileAsync(electronBin, [helper], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    const parsed = JSON.parse(stdout.trim());
    if (!parsed.sessionToken?.trim() || !parsed.userId?.trim()) {
      return null;
    }
    return {
      sessionToken: parsed.sessionToken.trim(),
      userId: parsed.userId.trim(),
      displayName: parsed.displayName?.trim() || undefined,
      profileImage: parsed.profileImage?.trim() || undefined,
      source: "keychain",
    };
  } catch (error) {
    const err = /** @type {NodeJS.ErrnoException & { code?: number | string }} */ (
      error
    );
    if (err.code === 2) {
      return null;
    }
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[testEnv] Session keychain lookup failed: ${detail}`);
    return null;
  }
}

/**
 * Resolve Papr Parse session for profile sync E2E (env vars or keychain).
 * @returns {Promise<{ sessionToken: string, userId: string, displayName?: string, profileImage?: string, source: string } | null>}
 */
export async function resolvePaprSessionCredentials(cwd = process.cwd()) {
  loadEnvLocal(cwd);
  const envToken = process.env.PAPR_SESSION_TOKEN?.trim();
  const envUserId = process.env.PAPR_USER_ID?.trim();
  if (envToken && envUserId) {
    return {
      sessionToken: envToken,
      userId: envUserId,
      source: "env",
    };
  }
  return resolvePaprSessionFromKeychain(cwd);
}

/** @returns {Promise<{ key: string, source: string } | null>} */
export async function resolvePaprApiKey(cwd = process.cwd()) {
  loadEnvLocal(cwd);
  const fromEnv = process.env.PAPR_API_KEY?.trim();
  if (fromEnv) {
    return { key: fromEnv, source: "env" };
  }

  const fromKeychain = await resolvePaprApiKeyFromKeychain(cwd);
  if (fromKeychain) {
    process.env.PAPR_API_KEY = fromKeychain;
    return { key: fromKeychain, source: "keychain" };
  }

  return null;
}

/**
 * Direct API key or local gateway proxy (uses Papr Work keychain when app is running).
 * @returns {Promise<
 *   | { mode: "direct", apiKey: string, memoryBase: string, source: string }
 *   | { mode: "gateway", gatewayBase: string, cloudBase: string, source: string }
 *   | null
 * >}
 */
export async function resolveMemoryAccess(cwd = process.cwd()) {
  const memoryBase = (
    process.env.PAPR_MEMORY_SERVER_URL ?? "https://memory.papr.ai"
  ).replace(/\/$/, "");

  const resolved = await resolvePaprApiKey(cwd);
  if (resolved) {
    return {
      mode: "direct",
      apiKey: resolved.key,
      memoryBase,
      source: resolved.source,
    };
  }

  const gatewayBase = (process.env.PAPR_GATEWAY_URL ?? "http://localhost:18789").replace(
    /\/$/,
    "",
  );

  try {
    const health = await fetch(`${gatewayBase}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!health.ok) {
      return null;
    }

    const probe = await fetch(`${gatewayBase}/api/cloud/databases/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(8_000),
    });

    if (probe.status === 401) {
      return null;
    }

    return {
      mode: "gateway",
      gatewayBase,
      cloudBase: `${gatewayBase}/api/cloud`,
      source: "gateway-keychain",
    };
  } catch {
    return null;
  }
}

export async function requireMemoryAccessAsync(cwd = process.cwd()) {
  const access = await resolveMemoryAccess(cwd);
  if (!access) {
    console.error("❌ Papr Memory access required");
    console.error(
      "   Login with Papr in Papr Work, keep the app running, or set PAPR_API_KEY in .env.local",
    );
    process.exit(1);
  }

  if (access.mode === "direct") {
    console.log(`API key: ${access.apiKey.slice(0, 24)}... (${access.source})`);
  } else {
    console.log(`Memory via gateway: ${access.cloudBase} (${access.source})`);
  }

  return access;
}

/** @deprecated Prefer requireMemoryAccessAsync — keychain-only without gateway fallback. */
export async function requirePaprApiKeyAsync(cwd = process.cwd()) {
  const access = await requireMemoryAccessAsync(cwd);
  if (access.mode === "gateway") {
    console.error("❌ PAPR_API_KEY required for this script (no gateway proxy support)");
    process.exit(1);
  }
  return access.apiKey;
}
