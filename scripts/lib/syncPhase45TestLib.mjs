/**
 * Shared helpers for Phase 4+5 sync E2E (flushAppNow + SyncCoordinator).
 */

import * as fs from "fs";
import * as path from "path";

export const GREEN = "\x1b[92m";
export const RED = "\x1b[91m";
export const YELLOW = "\x1b[93m";
export const CYAN = "\x1b[96m";
export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";

/** @typedef {{ passed: number, failed: number, skipped: number }} TestCounters */

/**
 * @param {string} name
 * @param {boolean} condition
 * @param {string} [detail]
 * @param {TestCounters} counters
 */
export function check(name, condition, detail = "", counters) {
  if (condition) {
    console.log(`  ${GREEN}PASS${RESET} ${name}`);
    counters.passed++;
  } else {
    console.log(`  ${RED}FAIL${RESET} ${name}${detail ? ` — ${detail}` : ""}`);
    counters.failed++;
  }
}

/**
 * @param {string} name
 * @param {string} reason
 * @param {TestCounters} counters
 */
export function skip(name, reason, counters) {
  console.log(`  ${YELLOW}SKIP${RESET} ${name} — ${reason}`);
  counters.skipped++;
}

/**
 * @param {string} label
 * @param {unknown} detail
 */
export function failFast(label, detail) {
  console.error(`\n${RED}❌ FAIL [${label}]:${RESET}`, detail);
  process.exit(1);
}

export function parsePaprApiKeyScope(apiKey) {
  const match = apiKey.match(/^sk-org-([^-]+)-namespace-([^-]+)(?:-.+)?$/);
  if (!match) return null;
  return { organizationId: match[1], namespaceId: match[2] };
}

/**
 * Configure process.env for Turso/memory from direct API key access.
 * @param {{ apiKey: string, memoryBase: string, source: string }} access
 */
export function applyDirectMemoryEnv(access) {
  process.env.PAPR_API_KEY = access.apiKey;
  process.env.PAPR_MEMORY_SERVER_URL = access.memoryBase.replace(/\/$/, "");
  const keyScope = parsePaprApiKeyScope(access.apiKey);
  if (keyScope) {
    process.env.PAPR_ORG_ID = keyScope.organizationId;
    process.env.PAPR_NAMESPACE_ID = keyScope.namespaceId;
  }
  process.env.NODE_ENV = "development";
  process.env.GATEWAY_MODE = process.env.GATEWAY_MODE ?? "cloud_agent";
  process.env.TURSO_PUSH_DEBOUNCE_MS = process.env.TURSO_PUSH_DEBOUNCE_MS ?? "800";
}

export function writeMinimalAppTree(appsRoot, appId, marker) {
  const appDir = path.join(appsRoot, appId);
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, "index.html"),
    `<!DOCTYPE html><html><body>${marker}</body></html>`,
    "utf8",
  );
}

export function writeAutoUploadPrefs(paprHome, appId) {
  const prefsPath = path.join(paprHome, "data", "cloud-publish-prefs.json");
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  fs.writeFileSync(
    prefsPath,
    JSON.stringify(
      {
        apps: {
          [appId]: {
            autoPublish: true,
            cloudEnabled: true,
            uploadMode: "auto",
            accessMode: "team",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

export function writeManualUploadPrefs(paprHome, appId) {
  const prefsPath = path.join(paprHome, "data", "cloud-publish-prefs.json");
  let existing = { apps: {} };
  try {
    existing = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
    if (!existing.apps || typeof existing.apps !== "object") {
      existing = { apps: {} };
    }
  } catch {
    /* first write */
  }
  existing.apps[appId] = {
    autoPublish: false,
    cloudEnabled: true,
    uploadMode: "manual",
    accessMode: "private",
  };
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  fs.writeFileSync(prefsPath, JSON.stringify(existing, null, 2), "utf8");
}

/**
 * Minimal CloudSyncService stub for flushAppNow / coordinator tests.
 * @param {string} paprHome
 * @param {object} [opts]
 * @param {string[]} [opts.callOrder]
 * @param {string[]} [opts.enqueueCalls]
 */
export function createCoordinatorSyncStub(paprHome, opts = {}) {
  const callOrder = opts.callOrder ?? [];
  const enqueueCalls = opts.enqueueCalls ?? [];

  return {
    getPaprDir: () => paprHome,
    pushGitNow: async (pushOpts) => {
      callOrder.push("git");
      if (pushOpts?.skipPostSyncHooks !== true) {
        callOrder.push("git-post-hooks-unexpected");
      }
      return {
        pushedPaths: [`apps/stub`],
        skippedPaths: [],
        scope: "app",
        appId: "stub",
      };
    },
    markAppForPostFlushHooks: () => {
      callOrder.push("mark-post-flush");
    },
    runPostFlushHooks: async () => {
      callOrder.push("post-flush-hooks");
    },
    runGit: async () => "",
    enqueueRelativePath: (relativePath) => {
      enqueueCalls.push(relativePath);
    },
    hasRelativePathChanged: () => true,
    markRelativePathSynced: () => {
      callOrder.push("mark-synced");
    },
  };
}

/**
 * @param {string} gateway
 * @param {string} method
 * @param {string} urlPath
 * @param {object | null} [body]
 * @param {number} [timeoutMs]
 */
export async function jsonFetch(gateway, method, urlPath, body = null, timeoutMs = 180_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
    signal: controller.signal,
  };
  if (body) opts.body = JSON.stringify(body);
  try {
    const resp = await fetch(`${gateway}${urlPath}`, opts);
    clearTimeout(timer);
    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: resp.status, data };
  } catch (err) {
    clearTimeout(timer);
    return { status: 0, data: { error: err.message } };
  }
}
