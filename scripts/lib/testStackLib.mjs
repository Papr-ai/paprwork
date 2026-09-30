/**
 * Shared helpers for test-stack orchestrator and sequential runner.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { SERVICE_ENDPOINTS } from "./testSuiteManifest.mjs";
import { loadEnvLocal, resolveMemoryAccess } from "./testEnv.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, "../..");
export const STACK_DIR = join(REPO_ROOT, ".test-stack");
export const STATE_FILE = join(STACK_DIR, "state.json");
export const LOG_DIR = join(STACK_DIR, "logs");
export const REPORT_DIR = join(REPO_ROOT, "test_reports");

/** Default sibling memory repo path. */
export const DEFAULT_MEMORY_REPO = join(REPO_ROOT, "..", "memory");

/** Memory server URL from env (prod or local). */
export function getMemoryServerUrl() {
  loadEnvLocal(REPO_ROOT);
  return (
    process.env.PAPR_MEMORY_SERVER_URL?.replace(/\/$/, "") ??
    "https://memory.papr.ai"
  );
}

/** @returns {boolean} true when URL points at local memory (:5001). */
export function isLocalMemoryUrl(url = getMemoryServerUrl()) {
  return /localhost|127\.0\.0\.1|:5001/.test(url);
}

/**
 * @param {number} ms
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function ensureStackDirs() {
  mkdirSync(STACK_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(REPORT_DIR, { recursive: true });
}

/**
 * @returns {import('./testStackLib.mjs').StackState | null}
 */
export function readStackState() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

/**
 * @param {import('./testStackLib.mjs').StackState} state
 */
export function writeStackState(state) {
  ensureStackDirs();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function clearStackState() {
  if (existsSync(STATE_FILE)) {
    rmSync(STATE_FILE);
  }
}

/**
 * @typedef {object} StackServiceRecord
 * @property {string} type 'process' | 'docker'
 * @property {number} [pid]
 * @property {number} [port]
 * @property {string} [logFile]
 * @property {string} [key] cloud agent gateway key
 * @property {string} [composeDir]
 */

/**
 * @typedef {object} StackState
 * @property {string} startedAt
 * @property {Record<string, StackServiceRecord>} services
 */

/**
 * @param {string} baseUrl
 * @param {string} healthPath
 * @param {Record<string, string>} [headers]
 * @param {number} [timeoutMs]
 */
export async function waitForHttpHealth(
  baseUrl,
  healthPath,
  headers = {},
  timeoutMs = 120_000,
) {
  const url = `${baseUrl.replace(/\/$/, "")}${healthPath}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.ok) return true;
    } catch {
      /* retry */
    }
    await sleep(1_000);
  }
  return false;
}

/**
 * @param {keyof typeof SERVICE_ENDPOINTS} serviceId
 * @param {StackState | null} [state]
 */
export async function isServiceHealthy(serviceId, state = readStackState()) {
  if (serviceId === "memory") {
    return isMemoryServerHealthy();
  }

  const endpoint = SERVICE_ENDPOINTS[serviceId];
  if (!endpoint) return false;

  const baseUrl = `http://127.0.0.1:${endpoint.port}`;
  /** @type {Record<string, string>} */
  const headers = {};
  if (serviceId === "cloudAgentGateway" && state?.services?.cloudAgentGateway?.key) {
    headers["X-Cloud-Agent-Gateway-Key"] = state.services.cloudAgentGateway.key;
  }

  try {
    const resp = await fetch(`${baseUrl}${endpoint.healthPath}`, {
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/** Health check for configured memory server (prod or local). */
export async function isMemoryServerHealthy() {
  const memoryBase = getMemoryServerUrl();
  return waitForHttpHealth(memoryBase, "/health", {}, 8_000);
}

/**
 * @param {import('./testSuiteManifest.mjs').ServiceRequirement} requirement
 * @param {StackState | null} [state]
 */
export async function checkRequirement(requirement, state = readStackState()) {
  loadEnvLocal(REPO_ROOT);

  switch (requirement) {
    case "gateway":
    case "memory":
    case "cloudAppHost":
    case "cloudAgentGateway":
      return isServiceHealthy(requirement, state);
    case "auth": {
      const access = await resolveMemoryAccess(REPO_ROOT);
      return access !== null;
    }
    case "anthropic":
      return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
    default:
      return false;
  }
}

/**
 * @param {import('./testSuiteManifest.mjs').ServiceRequirement[]} requirements
 */
export async function checkRequirements(requirements) {
  /** @type {Record<string, boolean>} */
  const results = {};
  for (const req of requirements) {
    results[req] = await checkRequirement(req);
  }
  return results;
}

/**
 * Start gateway as standalone Node process (no Electron).
 * @param {StackState} state
 */
export async function startGateway(state) {
  if (await isServiceHealthy("gateway")) {
    console.log("  Gateway already healthy on :18789");
    return;
  }

  spawnSync("npm", ["run", "build:gateway"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: true,
  });

  const logFile = join(LOG_DIR, "gateway.log");
  const out = openSync(logFile, "a");
  const err = openSync(logFile, "a");

  const child = spawn(process.execPath, ["dist/gateway/index.js"], {
    cwd: REPO_ROOT,
    env: { ...process.env, NODE_ENV: "production" },
    detached: true,
    stdio: ["ignore", out, err],
  });

  if (!child.pid) {
    throw new Error("Failed to start gateway");
  }
  child.unref();

  state.services.gateway = {
    type: "process",
    pid: child.pid,
    port: SERVICE_ENDPOINTS.gateway.port,
    logFile,
  };

  const ok = await waitForHttpHealth(
    "http://127.0.0.1:18789",
    "/health",
    {},
    60_000,
  );
  if (!ok) {
    throw new Error("Gateway did not become healthy within 60s — see .test-stack/logs/gateway.log");
  }
  console.log(`  Gateway started (pid ${child.pid}) → http://127.0.0.1:18789`);
}

/**
 * Start memory server via poetry/python (no Docker) — same as memory project dev.
 * @param {StackState} state
 * @param {string} [memoryRepoPath]
 */
export async function startMemoryLocal(state, memoryRepoPath = DEFAULT_MEMORY_REPO) {
  const memoryBase = "http://127.0.0.1:5001";
  if (await waitForHttpHealth(memoryBase, "/health", {}, 5_000)) {
    console.log(`  Memory server already healthy → ${memoryBase}`);
    process.env.PAPR_MEMORY_SERVER_URL = memoryBase;
    return;
  }

  const mainPy = join(memoryRepoPath, "main.py");
  if (!existsSync(mainPy)) {
    throw new Error(
      `Memory main.py not found at ${mainPy}. Clone ../memory or pass --memory-repo=PATH`,
    );
  }

  const logFile = join(LOG_DIR, "memory.log");
  const out = openSync(logFile, "a");
  const err = openSync(logFile, "a");

  const poetryOk =
    spawnSync("poetry", ["--version"], { encoding: "utf8", stdio: "pipe" }).status === 0;

  /** @type {[string, string[]]} */
  const launch = poetryOk
    ? ["poetry", ["run", "python", "main.py"]]
    : ["python3", ["main.py"]];

  console.log(`  Starting memory server (${launch[0]} ${launch[1].join(" ")}) in ${memoryRepoPath}...`);

  const child = spawn(launch[0], launch[1], {
    cwd: memoryRepoPath,
    detached: true,
    stdio: ["ignore", out, err],
    env: {
      ...process.env,
      PAPR_EDITION: process.env.PAPR_EDITION ?? "cloud",
    },
  });

  if (!child.pid) {
    throw new Error("Failed to start local memory server");
  }
  child.unref();

  state.services.memory = {
    type: "process",
    pid: child.pid,
    port: 5001,
    logFile,
    composeDir: memoryRepoPath,
  };

  process.env.PAPR_MEMORY_SERVER_URL = memoryBase;
  const ok = await waitForHttpHealth(memoryBase, "/health", {}, 180_000);
  if (!ok) {
    throw new Error(
      "Local memory server did not become healthy within 180s — see .test-stack/logs/memory.log",
    );
  }
  console.log(`  Memory server started (pid ${child.pid}) → ${memoryBase}`);
}

/**
 * @param {StackState} state
 * @param {string} [memoryRepoPath]
 */
export async function startMemoryDocker(state, memoryRepoPath = DEFAULT_MEMORY_REPO) {
  if (await waitForHttpHealth("http://127.0.0.1:5001", "/health", {}, 3_000)) {
    console.log("  Memory server already healthy on :5001");
    process.env.PAPR_MEMORY_SERVER_URL = "http://127.0.0.1:5001";
    return;
  }

  const composeFile = join(memoryRepoPath, "docker-compose.yaml");
  if (!existsSync(composeFile)) {
    throw new Error(
      `Memory docker-compose not found at ${composeFile}. Clone ../memory or pass --memory-repo=PATH`,
    );
  }

  console.log(`  Starting memory docker-compose in ${memoryRepoPath}...`);
  const result = spawnSync("docker", ["compose", "up", "-d"], {
    cwd: memoryRepoPath,
    stdio: "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error("docker compose up failed");
  }

  state.services.memory = {
    type: "docker",
    port: SERVICE_ENDPOINTS.memory.port,
    composeDir: memoryRepoPath,
  };

  const memoryBase =
    process.env.PAPR_MEMORY_SERVER_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:5001";
  const ok = await waitForHttpHealth(memoryBase, "/health", {}, 120_000);
  if (!ok) {
    throw new Error("Memory server did not become healthy within 120s");
  }
  console.log(`  Memory server healthy → ${memoryBase}`);
}

/**
 * @param {StackState} state
 * @param {string} npmScript
 * @param {string} serviceKey
 * @param {keyof typeof SERVICE_ENDPOINTS} serviceId
 * @param {NodeJS.ProcessEnv} [extraEnv]
 */
export async function startNpmService(state, npmScript, serviceKey, serviceId, extraEnv = {}) {
  if (await isServiceHealthy(serviceId, state)) {
    console.log(`  ${SERVICE_ENDPOINTS[serviceId].label} already healthy`);
    return;
  }

  spawnSync("npm", ["run", "build:gateway"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: true,
  });

  const logFile = join(LOG_DIR, `${serviceKey}.log`);
  const out = openSync(logFile, "a");
  const err = openSync(logFile, "a");

  const child = spawn("npm", ["run", npmScript], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...extraEnv },
    detached: true,
    stdio: ["ignore", out, err],
    shell: true,
  });

  if (!child.pid) {
    throw new Error(`Failed to start ${serviceKey}`);
  }
  child.unref();

  const endpoint = SERVICE_ENDPOINTS[serviceId];
  /** @type {StackServiceRecord} */
  const record = {
    type: "process",
    pid: child.pid,
    port: endpoint.port,
    logFile,
  };
  if (extraEnv.PAPR_CLOUD_AGENT_GATEWAY_KEY) {
    record.key = extraEnv.PAPR_CLOUD_AGENT_GATEWAY_KEY;
  }
  state.services[serviceKey] = record;

  /** @type {Record<string, string>} */
  const headers = {};
  if (record.key) {
    headers["X-Cloud-Agent-Gateway-Key"] = record.key;
  }

  const ok = await waitForHttpHealth(
    `http://127.0.0.1:${endpoint.port}`,
    endpoint.healthPath,
    headers,
    90_000,
  );
  if (!ok) {
    throw new Error(`${endpoint.label} did not become healthy — see ${logFile}`);
  }
  console.log(`  ${endpoint.label} started (pid ${child.pid}) → :${endpoint.port}`);
}

/**
 * @param {StackState} state
 */
export async function stopStack(state) {
  for (const [name, svc] of Object.entries(state.services ?? {})) {
    if (svc.type === "process" && svc.pid) {
      try {
        process.kill(svc.pid, "SIGTERM");
        console.log(`  Stopped ${name} (pid ${svc.pid})`);
      } catch {
        console.log(`  ${name} (pid ${svc.pid}) already stopped`);
      }
    }
  }

  const memory = state.services?.memory;
  if (memory?.type === "docker" && memory.composeDir) {
    console.log(`  Stopping memory docker-compose in ${memory.composeDir}...`);
    spawnSync("docker", ["compose", "down"], {
      cwd: memory.composeDir,
      stdio: "inherit",
    });
  }

  clearStackState();
}

/**
 * @param {object} options
 * @param {boolean} [options.gateway]
 * @param {boolean} [options.memoryLocal] poetry/python main.py (no Docker)
 * @param {boolean} [options.memoryDocker] docker compose in ../memory
 * @param {string} [options.memoryRepoPath]
 */
export async function startStack(options) {
  ensureStackDirs();
  loadEnvLocal(REPO_ROOT);

  /** @type {StackState} */
  const state = readStackState() ?? {
    startedAt: new Date().toISOString(),
    services: {},
  };

  if (options.gateway) {
    await startGateway(state);
  }
  if (options.memoryLocal) {
    await startMemoryLocal(state, options.memoryRepoPath);
  } else if (options.memoryDocker) {
    await startMemoryDocker(state, options.memoryRepoPath);
  }
  if (options.cloudAppHost) {
    await startNpmService(state, "start:cloud-app-host", "cloudAppHost", "cloudAppHost");
  }
  if (options.cloudAgentGateway) {
    const key =
      process.env.PAPR_CLOUD_AGENT_GATEWAY_KEY ??
      `local-e2e-${randomBytes(8).toString("hex")}`;
    process.env.PAPR_CLOUD_AGENT_GATEWAY_KEY = key;
    await startNpmService(
      state,
      "start:cloud-agent-gateway",
      "cloudAgentGateway",
      "cloudAgentGateway",
      {
        PAPR_CLOUD_AGENT_GATEWAY_KEY: key,
        CLOUD_AGENT_GATEWAY_URL: "http://127.0.0.1:8788",
      },
    );
  }

  state.startedAt = new Date().toISOString();
  writeStackState(state);
  return state;
}

/**
 * Print health status for all known services.
 */
export async function printStackStatus() {
  const state = readStackState();
  const memoryUrl = getMemoryServerUrl();
  console.log("\nTest stack status\n");
  console.log(`  Memory URL: ${memoryUrl}`);

  for (const [id, endpoint] of Object.entries(SERVICE_ENDPOINTS)) {
    const healthy = await isServiceHealthy(/** @type {keyof typeof SERVICE_ENDPOINTS} */ (id), state);
    const icon = healthy ? "✓" : "✗";
    const record = state?.services?.[id];
    const pid = record?.pid ? ` pid=${record.pid}` : "";
    const label =
      id === "memory"
        ? `Memory server (${memoryUrl})`
        : `${endpoint.label} (:${endpoint.port})`;
    console.log(`  ${icon} ${label}${pid}`);
  }

  const auth = await checkRequirement("auth");
  const anthropic = await checkRequirement("anthropic");
  console.log(`  ${auth ? "✓" : "✗"} Papr auth (API key / gateway keychain)`);
  console.log(`  ${anthropic ? "✓" : "✗"} ANTHROPIC_API_KEY`);

  if (state) {
    console.log(`\n  State file: ${STATE_FILE}`);
    console.log(`  Started: ${state.startedAt}`);
  } else {
    console.log("\n  No managed stack state (.test-stack/state.json)");
  }
  console.log("");
}
