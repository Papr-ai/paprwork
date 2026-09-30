/**
 * Shared harness for Plan A Turso replica production E2E tests.
 * Uses gateway cloud proxy for Turso tokens when Papr Work is running (same as customers).
 */

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { loadEnvLocal, resolveMemoryAccess, resolvePaprApiKey } from "./testEnv.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(__dirname, "../..");
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));

/** @typedef {{ id: string, pass: boolean, detail: string }} E2eResult */

/** @type {E2eResult[]} */
export const results = [];

export function record(id, pass, detail) {
  results.push({ id, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} [${id}] ${detail}`);
}

export function printSummary() {
  console.log("\n=== SUMMARY ===");
  let passed = 0;
  for (const row of results) {
    console.log(`${row.pass ? "PASS" : "FAIL"} [${row.id}] ${row.detail}`);
    if (row.pass) passed += 1;
  }
  console.log(`\n${passed}/${results.length} passed\n`);
  return passed === results.length;
}

export function cleanupSqlite(base) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(base + suffix);
    } catch {
      /* ignore */
    }
  }
}

export function readActiveWorkspace() {
  const pointerPath = path.join(os.homedir(), "Papr", ".active-workspace.json");
  const parsed = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
  if (!parsed.paprHome?.trim()) {
    throw new Error("Missing paprHome in .active-workspace.json");
  }
  return {
    paprHome: path.resolve(parsed.paprHome),
    orgId: parsed.orgId,
    namespaceId: parsed.namespaceId,
  };
}

export function applyReplicaE2eEnv(workspace) {
  process.env.PAPR_HOME = workspace.paprHome;
  process.env.PAPR_ORG_ID = workspace.orgId;
  process.env.PAPR_NAMESPACE_ID = workspace.namespaceId;
  process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
  process.env.PAPR_TURSO_REPLICA_SYNC_ALLOW_PRODUCTION = "1";
  process.env.CLOUD_SYNC_ENABLED = "true";
  process.env.TURSO_SYNC_ENABLED = "true";
}

/**
 * Resolve Papr Memory / Turso access. Prefers gateway keychain proxy (production path).
 * @returns {Promise<NonNullable<Awaited<ReturnType<typeof resolveMemoryAccess>>>}
 */
export async function requireReplicaE2eAccess() {
  loadEnvLocal(REPO_ROOT);
  const access = await resolveMemoryAccess(REPO_ROOT);
  if (!access) {
    throw new Error(
      "Papr access required — login in Papr Work (keep app running) or set PAPR_API_KEY in .env.local for the active workspace namespace",
    );
  }
  if (access.mode === "direct") {
    process.env.PAPR_API_KEY = access.apiKey;
    console.log(`Auth: direct API key (${access.source})`);
  } else {
    console.log(`Auth: gateway cloud proxy (${access.gatewayBase})`);
  }
  return access;
}

/**
 * Fetch Turso credentials using the same path as spike / production gateway proxy.
 * @param {Awaited<ReturnType<typeof requireReplicaE2eAccess>>} access
 * @param {string} tursoDatabase
 */
export async function fetchTursoCredentials(access, tursoDatabase) {
  const cloudBase =
    access.mode === "gateway"
      ? access.cloudBase
      : `${access.memoryBase.replace(/\/$/, "")}/v1/cloud`;

  const headers = { "Content-Type": "application/json" };
  if (access.mode === "direct") {
    headers["X-API-Key"] = access.apiKey;
  }

  const res = await fetch(`${cloudBase}/databases/token`, {
    method: "POST",
    headers,
    body: JSON.stringify({ database: tursoDatabase }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 400);
    throw new Error(`Turso token request failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  if (!data.tursoUrl || !data.authToken) {
    throw new Error(`Turso token response missing fields for ${tursoDatabase}`);
  }
  return { tursoUrl: data.tursoUrl, authToken: data.authToken };
}

/**
 * Patch TursoSyncBridge.fetchCredentials to use gateway proxy (fixes standalone script auth).
 * @param {import('@tursodatabase/sync').Database} bridge
 * @param {Awaited<ReturnType<typeof requireReplicaE2eAccess>>} access
 */
export function patchBridgeCredentials(bridge, access) {
  const original = bridge.fetchCredentials.bind(bridge);
  bridge.fetchCredentials = async (databaseName) => {
    try {
      return await fetchTursoCredentials(access, databaseName);
    } catch (error) {
      console.warn(
        `[replicaE2e] gateway token fetch failed for ${databaseName}, falling back to bridge:`,
        error instanceof Error ? error.message.slice(0, 120) : String(error),
      );
      return original(databaseName);
    }
  };
}

export async function importDist(modulePath) {
  const abs = path.join(REPO_ROOT, "dist", modulePath);
  return import(pathToFileURL(abs).href);
}

export async function reloadRegistry() {
  const { resetDatabaseRegistryForWorkspaceSwitch, initializeDatabaseRegistry } =
    await importDist("gateway/services/DatabaseRegistryService.js");
  resetDatabaseRegistryForWorkspaceSwitch();
  await initializeDatabaseRegistry();
}

export async function resetReplicaConnections() {
  const { getTursoReplicaService, resetTursoReplicaServiceForTests } =
    await importDist("gateway/services/tursoReplica/TursoReplicaService.js");
  const service = getTursoReplicaService();
  await service.closeAll();
  resetTursoReplicaServiceForTests();
}

export function makeSource(dbId, slug, localPath, linkedAt) {
  return {
    id: dbId,
    type: "sqlite",
    dbId,
    alias: slug,
    dbPath: localPath,
    tables: [],
    linkedAt,
  };
}

export async function writeMigration(migrationRoot, fileName, sql) {
  const dir = path.join(migrationRoot, "migrations");
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, fileName), `${sql.trim()}\n`, "utf8");
}

export async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isHostNotReadyError(error) {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes("404") || msg.includes("Host not found") || msg.includes("not found");
}

export async function connectWithRetry(connectFn, label = "connect") {
  const delays = [0, 1500, 3000, 5000, 8000];
  let lastError;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) {
      await sleep(delays[attempt]);
    }
    try {
      return await connectFn();
    } catch (error) {
      lastError = error;
      if (!isHostNotReadyError(error) || attempt === delays.length - 1) {
        throw error;
      }
      console.log(`  … retry ${label} in ${delays[attempt + 1] ?? 0}ms`);
    }
  }
  throw lastError;
}

export async function remoteExec(creds, sql) {
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url: creds.tursoUrl, authToken: creds.authToken });
  try {
    await client.execute(sql);
  } finally {
    client.close();
  }
}

export async function remoteQuery(creds, sql) {
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url: creds.tursoUrl, authToken: creds.authToken });
  try {
    return await client.execute(sql);
  } finally {
    client.close();
  }
}

/**
 * @typedef {object} ThrowawayFixture
 * @property {string} dbId
 * @property {string} slug
 * @property {string} localPath
 * @property {string} tursoShortName
 * @property {string} tursoDatabase
 * @property {string} migrationRoot
 * @property {string} appId
 * @property {string} registryPath
 * @property {string | null} registryBackup
 * @property {string | null} appsBackup
 * @property {object} registry
 * @property {string} now
 */

/**
 * Create isolated throwaway registry DB + optional gateway mini-app fixture.
 * @param {Awaited<ReturnType<typeof requireReplicaE2eAccess>>} access
 * @param {{ withApp?: boolean, skipRegistryBackup?: boolean, syncMode?: 'legacy' | 'replica' }} [options]
 * @returns {Promise<ThrowawayFixture>}
 */
export async function createThrowawayFixture(access, options = {}) {
  const syncMode = options.syncMode ?? "replica";
  const workspace = readActiveWorkspace();
  applyReplicaE2eEnv(workspace);

  const { tursoNameForRecord } = await importDist(
    "gateway/services/DatabaseRegistryService.js",
  );

  const dbId = `db-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const slug = `replica-e2e-${Date.now().toString(36)}`;
  const dbRoot = path.join(workspace.paprHome, "data", "databases", slug);
  const localPath = path.join(dbRoot, "data.db");
  const tursoShortName = `d-${dbId.replace(/^db-/, "").slice(0, 8)}`;
  const migrationRoot = dbRoot;
  const now = new Date().toISOString();
  const appId = randomUUID();

  const registryPath = path.join(workspace.paprHome, "data", "databases.json");
  const registryBackup =
    !options.skipRegistryBackup && fs.existsSync(registryPath)
      ? `${registryPath}.replica-e2e-${Date.now()}`
      : null;
  const registry = fs.existsSync(registryPath)
    ? JSON.parse(fs.readFileSync(registryPath, "utf8"))
    : { version: 1, databases: {} };

  if (registryBackup) {
    await fs.promises.copyFile(registryPath, registryBackup);
  }

  registry.databases[dbId] = {
    dbId,
    localPath,
    tursoShortName,
    label: "Replica Production E2E (throwaway)",
    isolation: "shared",
    status: "active",
    syncMode,
    createdAt: now,
    updatedAt: now,
  };
  await fs.promises.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  await fs.promises.mkdir(dbRoot, { recursive: true });

  let appsBackup = null;
  if (options.withApp) {
    const appsRoot = path.join(workspace.paprHome, "apps");
    const appsJsonPath = path.join(workspace.paprHome, "data", "apps.json");
    if (fs.existsSync(appsJsonPath)) {
      appsBackup = `${appsJsonPath}.replica-e2e-${Date.now()}`;
      await fs.promises.copyFile(appsJsonPath, appsBackup);
    }
    const apps = fs.existsSync(appsJsonPath)
      ? JSON.parse(fs.readFileSync(appsJsonPath, "utf8"))
      : [];
    apps.push({
      id: appId,
      title: "Replica E2E Throwaway",
      description: "Auto-created for production replica E2E — safe to delete",
      type: "app",
      createdAt: now,
      updatedAt: now,
    });
    await fs.promises.writeFile(appsJsonPath, `${JSON.stringify(apps, null, 2)}\n`, "utf8");

    const appDir = path.join(appsRoot, appId);
    await fs.promises.mkdir(appDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(appDir, "data-sources.json"),
      `${JSON.stringify(
        {
          sources: [
            {
              id: dbId,
              type: "sqlite",
              dbId,
              alias: slug,
              dbPath: localPath,
              tables: [],
              linkedAt: now,
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.promises.writeFile(
      path.join(appDir, "index.html"),
      "<!doctype html><html><body>replica e2e</body></html>\n",
      "utf8",
    );
  }

  const tursoDatabase = tursoNameForRecord({
    dbId,
    tursoShortName,
    isolation: "shared",
  });

  return {
    dbId,
    slug,
    localPath,
    tursoShortName,
    tursoDatabase,
    migrationRoot,
    appId,
    registryPath,
    registryBackup,
    appsBackup,
    registry,
    now,
  };
}

export async function provisionTursoReplica(creds, localPath) {
  cleanupSqlite(localPath);
  const { connect } = await import("@tursodatabase/sync");
  const db = await connectWithRetry(
    () =>
      connect({
        path: localPath,
        url: creds.tursoUrl,
        authToken: creds.authToken,
        bootstrapIfEmpty: true,
      }).then(async (handle) => {
        await handle.connect();
        return handle;
      }),
    "provision",
  );
  await db.exec("SELECT 1");
  await db.push();
  await db.close();
  cleanupSqlite(localPath);
}

/**
 * Throwaway DB for gateway HTTP tests only — schema seeded on Turso, no local @tursodatabase/sync open in the test process.
 * @param {Awaited<ReturnType<typeof requireReplicaE2eAccess>>} access
 */
export async function createHttpOnlyThrowawayFixture(access) {
  const fixture = await createThrowawayFixture(access, {
    withApp: false,
    skipRegistryBackup: true,
  });
  const creds = await fetchTursoCredentials(access, fixture.tursoDatabase);
  await provisionTursoReplica(creds, `${fixture.localPath}.http-provision-tmp`);
  await remoteExec(
    creds,
    "CREATE TABLE IF NOT EXISTS e2e_items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)",
  );
  return fixture;
}

/** @param {ThrowawayFixture} fixture */
export async function warmupTursoDatabaseHost(creds, localPath) {
  const { connect } = await import("@tursodatabase/sync");
  const warmupPath = `${localPath}.turso-warmup`;
  cleanupSqlite(warmupPath);
  const db = await connectWithRetry(
    () =>
      connect({
        path: warmupPath,
        url: creds.tursoUrl,
        authToken: creds.authToken,
        bootstrapIfEmpty: true,
      }).then(async (handle) => {
        await handle.connect();
        return handle;
      }),
    "turso-host-warmup",
  );
  await db.exec("SELECT 1");
  await db.close();
  cleanupSqlite(warmupPath);
}

export async function destroyThrowawayFixture(fixture) {
  delete fixture.registry.databases[fixture.dbId];
  if (fixture.registryBackup) {
    await fs.promises.copyFile(fixture.registryBackup, fixture.registryPath);
    await fs.promises.unlink(fixture.registryBackup);
  } else if (fs.existsSync(fixture.registryPath)) {
    const current = JSON.parse(fs.readFileSync(fixture.registryPath, "utf8"));
    delete current.databases[fixture.dbId];
    await fs.promises.writeFile(
      fixture.registryPath,
      `${JSON.stringify(current, null, 2)}\n`,
      "utf8",
    );
  }

  if (fixture.appsBackup) {
    const appsJsonPath = path.join(readActiveWorkspace().paprHome, "data", "apps.json");
    await fs.promises.copyFile(fixture.appsBackup, appsJsonPath);
    await fs.promises.unlink(fixture.appsBackup);
  } else if (fixture.appId) {
    const appsJsonPath = path.join(
      readActiveWorkspace().paprHome,
      "data",
      "apps.json",
    );
    if (fs.existsSync(appsJsonPath)) {
      const apps = JSON.parse(fs.readFileSync(appsJsonPath, "utf8"));
      const filtered = apps.filter((app) => app.id !== fixture.appId);
      await fs.promises.writeFile(appsJsonPath, `${JSON.stringify(filtered, null, 2)}\n`, "utf8");
    }
  }

  cleanupSqlite(fixture.localPath);
  try {
    await fs.promises.rm(path.dirname(fixture.localPath), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  if (fixture.appId) {
    try {
      await fs.promises.rm(path.join(readActiveWorkspace().paprHome, "apps", fixture.appId), {
        recursive: true,
        force: true,
      });
    } catch {
      /* ignore */
    }
  }
}

export async function gatewayFetch(gatewayBase, route, body) {
  const res = await fetch(`${gatewayBase}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, ok: res.ok, json };
}

export async function ensureGatewayHealthy(gatewayBase = "http://127.0.0.1:18789") {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${gatewayBase}/health`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) {
      throw new Error(`Gateway unhealthy at ${gatewayBase}/health (${res.status})`);
    }
    const json = await res.json().catch(() => ({}));
    if (json.status === "ok") {
      return gatewayBase;
    }
    await sleep(500);
  }
  throw new Error(`Gateway at ${gatewayBase} did not reach ready status=ok within 120s`);
}

/**
 * Pick an app ID that the running gateway has loaded in memory (AppService.apps).
 * @param {string} gatewayBase
 */
export async function resolveGatewayLoadedAppId(gatewayBase) {
  const workspace = readActiveWorkspace();
  const appsJsonPath = path.join(workspace.paprHome, "data", "apps.json");
  if (!fs.existsSync(appsJsonPath)) {
    throw new Error("apps.json missing — open Papr Work once so apps are registered");
  }
  const apps = JSON.parse(fs.readFileSync(appsJsonPath, "utf8"));
  if (!Array.isArray(apps) || apps.length === 0) {
    throw new Error("No apps in apps.json — need at least one loaded mini-app for HTTP E2E");
  }

  for (const app of apps) {
    if (!app?.id) continue;
    const res = await fetch(`${gatewayBase}/api/apps/${app.id}/link-database`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dbId: "__e2e_probe__" }),
      signal: AbortSignal.timeout(5_000),
    });
    const json = await res.json().catch(() => ({}));
    const message = typeof json.error === "string" ? json.error : "";
    if (res.status === 404 && message.includes("Database not found")) {
      return app.id;
    }
    if (res.status === 404 && message.includes("App not found")) {
      continue;
    }
    if (res.status === 400 && message.includes("dbId")) {
      return app.id;
    }
  }

  throw new Error(
    "No gateway-loaded app found — restart Papr Work so AppService reloads apps.json, then re-run",
  );
}

/**
 * Link throwaway registry DB to a gateway-loaded app via production /api/apps/link-database.
 * @param {string} gatewayBase
 * @param {string} appId
 * @param {ThrowawayFixture} fixture
 */
export async function linkThrowawayDbViaGateway(gatewayBase, appId, fixture) {
  const workspace = readActiveWorkspace();
  const dataSourcesPath = path.join(workspace.paprHome, "apps", appId, "data-sources.json");
  const backupPath = fs.existsSync(dataSourcesPath)
    ? `${dataSourcesPath}.replica-e2e-${Date.now()}`
    : null;
  if (backupPath) {
    await fs.promises.copyFile(dataSourcesPath, backupPath);
  }

  const res = await fetch(`${gatewayBase}/api/apps/${appId}/link-database`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dbId: fixture.dbId, alias: fixture.slug }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `link-database failed (${res.status}): ${typeof json.error === "string" ? json.error : JSON.stringify(json).slice(0, 200)}`,
    );
  }

  const sources = Array.isArray(json.sources) ? json.sources : [];
  const linked =
    sources.find((entry) => entry?.dbId === fixture.dbId) ??
    sources.find((entry) => entry?.alias === fixture.slug);
  if (!linked?.id) {
    throw new Error(
      `link-database succeeded but throwaway source missing from response: ${JSON.stringify(json).slice(0, 200)}`,
    );
  }

  return {
    appId,
    alias: linked.alias ?? fixture.slug,
    sourceId: linked.id,
    dataSourcesPath,
    dataSourcesBackup: backupPath,
  };
}

/** @param {{ dataSourcesPath: string, dataSourcesBackup: string | null }} linkState */
export async function restoreGatewayAppLink(linkState) {
  if (!linkState?.dataSourcesPath) return;
  if (linkState.dataSourcesBackup && fs.existsSync(linkState.dataSourcesBackup)) {
    await fs.promises.copyFile(linkState.dataSourcesBackup, linkState.dataSourcesPath);
    await fs.promises.unlink(linkState.dataSourcesBackup);
    return;
  }
  try {
    await fs.promises.unlink(linkState.dataSourcesPath);
  } catch {
    /* no file */
  }
}

/**
 * Resolve Electron binary (same runtime as production gateway subprocess).
 */
function resolveElectronBinary() {
  try {
    const electronPath = requireFromRepo("electron");
    if (typeof electronPath === "string" && electronPath.trim()) {
      return electronPath;
    }
  } catch {
    /* fall through */
  }
  return path.join(REPO_ROOT, "node_modules", ".bin", "electron");
}

/**
 * Start an isolated gateway for HTTP E2E (Electron runtime — matches production).
 * Create throwaway fixture (with app) BEFORE calling this so apps.json is loaded at boot.
 * @returns {Promise<{ gatewayBase: string, child: import('node:child_process').ChildProcess }>}
 */
export async function startIsolatedGateway() {
  const workspace = readActiveWorkspace();
  applyReplicaE2eEnv(workspace);

  const keyResult = await resolvePaprApiKey(REPO_ROOT);
  if (!keyResult?.key) {
    throw new Error(
      "--isolated-gateway requires PAPR_API_KEY in .env.local or Papr Work keychain (Electron subprocess)",
    );
  }
  process.env.PAPR_API_KEY = keyResult.key;

  const port = 18790;
  const gatewayBase = `http://127.0.0.1:${port}`;
  process.env.PAPR_GATEWAY_URL = gatewayBase;

  const electronBin = resolveElectronBinary();
  const gatewayScript = path.join(REPO_ROOT, "dist/gateway/index.js");
  const stderrLines = [];

  const child = spawn(electronBin, [gatewayScript], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GATEWAY_PORT: String(port),
      PAPR_HOME: workspace.paprHome,
      PAPR_ORG_ID: workspace.orgId,
      PAPR_NAMESPACE_ID: workspace.namespaceId,
      PAPR_API_KEY: keyResult.key,
      CLOUD_SYNC_ENABLED: "true",
      TURSO_SYNC_ENABLED: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    stderrLines.push(text);
    if (stderrLines.length > 40) {
      stderrLines.shift();
    }
  });
  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString();
    if (text.includes("[Gateway]") || text.includes("Error")) {
      process.stdout.write(text);
    }
  });

  child.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      console.warn(`[replicaE2e] isolated gateway exited code=${code} signal=${signal ?? ""}`);
    }
  });

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      break;
    }
    try {
      const res = await fetch(`${gatewayBase}/health`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) {
        // Wait for services to finish loading (health is live before AgentService init completes)
        await sleep(2_000);
        console.log(`Isolated gateway ready on ${gatewayBase} (pid ${child.pid}, Electron runtime)`);
        return { gatewayBase, child };
      }
    } catch {
      /* wait */
    }
    await sleep(500);
  }

  child.kill("SIGTERM");
  const tail = stderrLines.join("").slice(-2_000);
  throw new Error(
    `Isolated gateway did not become healthy on port ${port}${tail ? `\n${tail}` : ""}`,
  );
}

export function stopGateway(child) {
  if (child && !child.killed) {
    child.kill("SIGTERM");
  }
}
