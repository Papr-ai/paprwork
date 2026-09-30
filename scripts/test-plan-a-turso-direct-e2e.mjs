#!/usr/bin/env node
/**
 * Plan A local E2E — Cloud App Host + sandbox Turso-direct read/write.
 *
 * Validates:
 *   A. TursoDbAdapter writes directly to Turso primary (not workspace log) when
 *      PAPR_TURSO_REPLICA_SYNC=replica-records + PAPR_CLOUD_APP_HOST_KEY is set.
 *   B. Optional: live Cloud App Host HTTP POST /api/db/write + /api/db/query (:8787).
 *   C. Cloud sandbox resolves Turso creds and read/write via PAPR_DB_* env (no local file).
 *   D. Sandbox Turso write → cloud app host /api/db/query read + SSE jobs:db-changed (replica).
 *   E. Desktop replica loop — cloud/sandbox Turso write → paprDb.pull → local read; desktop write → Turso.
 *
 * Prerequisites:
 *   npm run build:gateway
 *   PAPR_API_KEY in .env.local OR Papr Work running (gateway Turso token proxy)
 *   PAPR_TURSO_REPLICA_SYNC=replica-records in .env.local (recommended)
 *   Optional HTTP: npm run start:cloud-app-host + gateway running for git sync push
 *
 * Usage:
 *   npm run test:plan-a-turso-direct-e2e
 *   node scripts/test-plan-a-turso-direct-e2e.mjs [--host URL] [--skip-http] [--gateway URL]
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadEnvLocal, resolvePaprApiKey, resolvePaprSessionCredentials } from "./lib/testEnv.mjs";
import {
  REPO_ROOT,
  applyReplicaE2eEnv,
  createThrowawayFixture,
  destroyThrowawayFixture,
  ensureGatewayHealthy,
  fetchTursoCredentials,
  importDist,
  makeSource,
  readActiveWorkspace,
  record,
  remoteExec,
  remoteQuery,
  patchBridgeCredentials,
  printSummary,
  provisionTursoReplica,
  reloadRegistry,
  requireReplicaE2eAccess,
  resetReplicaConnections,
  sleep,
  connectWithRetry,
  cleanupSqlite,
} from "./lib/replicaE2eHarness.mjs";

const args = new Set(process.argv.slice(2));
const hostBase = (
  args.has("--skip-http")
    ? null
    : (process.argv.find((a) => a.startsWith("--host="))?.split("=")[1] ??
      "http://127.0.0.1:8787")
)?.replace(/\/$/, "");
const gatewayBase = (
  process.argv.find((a) => a.startsWith("--gateway="))?.split("=")[1] ??
  "http://127.0.0.1:18789"
).replace(/\/$/, "");

function makeHarnessTursoCredentials(access) {
  return {
    getUserDatabaseToken: async (_orgId, _namespaceId, _userId, _runtimeAuth, database) =>
      fetchTursoCredentials(access, database),
  };
}

async function publishThrowawayApp(access, appId, slug) {
  if (access.mode === "gateway") {
    const res = await fetch(`${gatewayBase}/api/cloud/publish/${encodeURIComponent(appId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accessMode: "team",
        externalLink: "read_write",
        slug,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data, text };
  }

  return memoryFetch("/v1/cloud/apps/publish", {
    method: "POST",
    body: {
      appId,
      slug,
      visibility: "team",
      linkPermission: "read_write",
    },
  });
}

async function memoryFetch(pathname, { method = "GET", body = null } = {}) {
  loadEnvLocal(REPO_ROOT);
  const base =
    process.env.PAPR_MEMORY_SERVER_URL ??
    process.env.PAPR_AI_PROXY_BASE_URL?.replace(/\/v1\/ai\/?$/, "") ??
    "https://memory.papr.ai";
  let key = process.env.PAPR_API_KEY?.trim();
  if (!key) {
    const resolved = await resolvePaprApiKey(REPO_ROOT);
    key = resolved?.key;
  }
  if (!key) {
    throw new Error("PAPR_API_KEY required for memory publish");
  }
  process.env.PAPR_API_KEY = key;
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": key,
    },
  };
  if (body) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${pathname}`, opts);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, text };
}

async function seedRemoteSchema(creds) {
  await remoteExec(
    creds,
    "CREATE TABLE IF NOT EXISTS e2e_items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)",
  );
}

/**
 * Wait for a single SSE event on cloud app host (Node fetch stream parser).
 * @param {string} url
 * @param {{ eventType: string, dbId?: string, timeoutMs?: number }} options
 */
async function waitForSseEvent(url, { eventType, dbId, timeoutMs = 20_000 }) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`SSE connect failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
          continue;
        }
        if (!line.startsWith("data: ") || !currentEvent) {
          continue;
        }
        let data;
        try {
          data = JSON.parse(line.slice(6));
        } catch {
          currentEvent = "";
          continue;
        }
        if (currentEvent === eventType && (!dbId || data?.dbId === dbId)) {
          return { type: currentEvent, data };
        }
        currentEvent = "";
      }
    }
    throw new Error(`SSE closed without ${eventType}`);
  } finally {
    clearTimeout(deadline);
  }
}

async function notifyCloudHostDbChanged(hostBase, { dbId, jobId, tables = [] }) {
  const hostKey = process.env.PAPR_CLOUD_APP_HOST_KEY?.trim() || "plan-a-e2e-host-key";
  const res = await fetch(`${hostBase}/internal/db-changed`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cloud-App-Host-Key": hostKey,
    },
    body: JSON.stringify({
      ...(dbId ? { dbId } : {}),
      ...(jobId ? { jobId } : {}),
      tables,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

async function sandboxLibsqlWrite(access, workspace, fixture, creds, label) {
  const sandboxRoot = path.join(
    os.tmpdir(),
    "papr-cloud-run",
    `plan-a-sandbox-read-${Date.now().toString(36)}`,
  );
  const sandboxHome = path.join(sandboxRoot, "Papr");
  const origHome = process.env.PAPR_HOME;
  const origGatewayMode = process.env.GATEWAY_MODE;

  const { tursoCredsByDbIdFromCloudSources } = await importDist(
    "gateway/services/cloudAgentGateway/cloudSandboxTursoDirect.js",
  );
  const { resolveJobWriteTargets, jobWriteDatabaseEnv } = await importDist(
    "gateway/services/jobAppDatabase.js",
  );

  try {
    await fs.promises.mkdir(path.join(sandboxHome, "data"), { recursive: true });
    const dbRecord = fixture.registry.databases[fixture.dbId];
    await fs.promises.writeFile(
      path.join(sandboxHome, "data", "databases.json"),
      `${JSON.stringify({ version: 1, databases: { [fixture.dbId]: dbRecord } }, null, 2)}\n`,
      "utf8",
    );

    process.env.PAPR_HOME = sandboxHome;
    process.env.GATEWAY_MODE = "cloud_agent";
    process.env.PAPR_ORG_ID = workspace.orgId;
    process.env.PAPR_NAMESPACE_ID = workspace.namespaceId;
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";

    await reloadRegistry();

    const tursoSources = [
      {
        syncKey: fixture.dbId,
        dbPath: fixture.localPath,
        databaseShortName: fixture.tursoShortName,
        databaseUrl: creds.tursoUrl,
        authToken: creds.authToken,
      },
    ];

    const targets = await resolveJobWriteTargets(
      { writeDbIds: [fixture.dbId], appIds: [] },
      {
        actingUserId: "sandbox-e2e-user",
        tursoCredsByDbId: tursoCredsByDbIdFromCloudSources(tursoSources),
      },
    );
    const env = jobWriteDatabaseEnv(targets, fixture.appId);

    const { createClient } = await import("@libsql/client");
    const client = createClient({
      url: env.PAPR_DB_URL,
      authToken: env.PAPR_DB_AUTH_TOKEN,
    });
    try {
      const insert = await client.execute({
        sql: "INSERT INTO e2e_items (label) VALUES (?)",
        args: [label],
      });
      return insert.rowsAffected === 1;
    } finally {
      client.close();
    }
  } finally {
    if (origHome !== undefined) {
      process.env.PAPR_HOME = origHome;
    } else {
      delete process.env.PAPR_HOME;
    }
    if (origGatewayMode !== undefined) {
      process.env.GATEWAY_MODE = origGatewayMode;
    } else {
      delete process.env.GATEWAY_MODE;
    }
    await fs.promises.rm(sandboxRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function runTursoDbAdapterDirectWrite(access, workspace, fixture, creds) {
  console.log("\n--- A. Cloud App Host adapter — Turso primary write ---\n");

  process.env.PAPR_CLOUD_APP_HOST_KEY =
    process.env.PAPR_CLOUD_APP_HOST_KEY?.trim() || "plan-a-e2e-host-key";

  const { TursoDbAdapter } = await importDist("gateway/services/appRuntime/TursoDbAdapter.js");
  const { isTursoReplicaSyncFeatureEnabled } = await importDist(
    "gateway/utils/tursoReplicaEnabled.js",
  );

  record(
    "plan-a-rollout-enabled",
    isTursoReplicaSyncFeatureEnabled(),
    `PAPR_TURSO_REPLICA_SYNC=${process.env.PAPR_TURSO_REPLICA_SYNC ?? "(unset)"}`,
  );

  await reloadRegistry();
  await seedRemoteSchema(creds);

  const adapter = new TursoDbAdapter(makeHarnessTursoCredentials(access));
  const config = {
    sources: [makeSource(fixture.dbId, fixture.slug, fixture.localPath, fixture.now)],
  };
  const runtimeAuth = {
    namespaceId: workspace.namespaceId,
    slug: `plan-a-e2e-${Date.now().toString(36)}`,
    paprApiKey: access.mode === "direct" ? access.apiKey : process.env.PAPR_API_KEY,
  };
  const sourceId = fixture.slug;
  const label = `cloud-host-adapter-${Date.now().toString(36)}`;

  const writeResult = await adapter.write({
    orgId: workspace.orgId,
    namespaceId: workspace.namespaceId,
    userId: "plan-a-e2e-user",
    runtimeAuth,
    config,
    appId: fixture.appId ?? "plan-a-e2e-app",
    sourceId,
    sql: "INSERT INTO e2e_items (label) VALUES (?)",
    params: [label],
  });

  record(
    "adapter-direct-write",
    writeResult.changes === 1,
    `changes=${writeResult.changes} source=${writeResult.source}`,
  );

  const remote = await remoteQuery(
    creds,
    `SELECT label FROM e2e_items WHERE label = '${label.replace(/'/g, "''")}'`,
  );
  record(
    "adapter-remote-verify",
    remote.rows.length === 1,
    `remoteRows=${remote.rows.length}`,
  );

  const readResult = await adapter.query({
    orgId: workspace.orgId,
    namespaceId: workspace.namespaceId,
    userId: "plan-a-e2e-user",
    runtimeAuth,
    config,
    appId: fixture.appId ?? "plan-a-e2e-app",
    sourceId,
    sql: "SELECT label FROM e2e_items WHERE label = ?",
    params: [label],
  });
  record(
    "adapter-direct-read",
    readResult.count === 1,
    `count=${readResult.count}`,
  );
}

async function tryGatewayAppSync(appId) {
  try {
    await ensureGatewayHealthy(gatewayBase);
  } catch {
    return { ok: false, reason: "gateway not running" };
  }

  const res = await fetch(`${gatewayBase}/api/sync/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, reason: `sync push ${res.status}: ${text.slice(0, 120)}` };
  }
  return { ok: true };
}

async function runCloudAppHostHttp(access, workspace, httpFixture, creds) {
  console.log("\n--- B. Cloud App Host HTTP — /api/db/write + /api/db/query ---\n");

  if (!hostBase) {
    record("http-host", true, "skipped (--skip-http)");
    return;
  }

  if (!process.env.PAPR_API_KEY?.trim()) {
    await resolvePaprApiKey(REPO_ROOT);
  }
  const session = await resolvePaprSessionCredentials(REPO_ROOT);
  if (!session?.sessionToken) {
    record(
      "http-session",
      false,
      "Papr session required for team publish — sign in via Papr Work",
    );
    return;
  }
  record("http-session", true, `userId=${session.userId} (${session.source})`);

  let hostOk = false;
  try {
    const health = await fetch(`${hostBase}/health`, { signal: AbortSignal.timeout(5_000) });
    hostOk = health.ok;
  } catch (error) {
    record(
      "http-host-reachable",
      false,
      `${error instanceof Error ? error.message : error} — run: npm run start:cloud-app-host`,
    );
    return;
  }
  record("http-host-reachable", hostOk, hostBase);

  if (!httpFixture.appId) {
    record("http-throwaway-app", false, "fixture missing appId — recreate with withApp: true");
    return;
  }

  const sync = await tryGatewayAppSync(httpFixture.appId);
  if (sync.ok) {
    console.log("  … waiting for git sync after pushAppNow (up to 90s)");
    await sleep(15_000);
  } else {
    console.log(`  … sync push skipped: ${sync.reason}`);
  }

  const slug = `plan-a-e2e-${Date.now().toString(36)}`;
  const publish = await publishThrowawayApp(access, httpFixture.appId, slug);

  if (publish.status !== 200) {
    record(
      "http-publish",
      false,
      publish.text.slice(0, 200),
    );
    return;
  }
  record("http-publish", true, `slug=${slug}`);

  const namespaceId = workspace.namespaceId;
  const headers = {
    "Content-Type": "application/json",
    "X-Papr-Namespace-Id": namespaceId,
    "X-Papr-Slug": slug,
    "X-Session-Token": session.sessionToken,
    "X-Papr-External-User-Id": session.userId,
  };
  if (process.env.PAPR_API_KEY?.trim()) {
    headers["X-API-Key"] = process.env.PAPR_API_KEY.trim();
  }

  const sourceId = httpFixture.slug;
  const label = `cloud-host-http-${Date.now().toString(36)}`;

  let writeOk = false;
  let writeJson = null;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const writeRes = await fetch(`${hostBase}/api/db/write`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        appId: httpFixture.appId,
        sourceId,
        sql: "INSERT INTO e2e_items (label) VALUES (?)",
        params: [label],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await writeRes.text();
    try {
      writeJson = JSON.parse(text);
    } catch {
      writeJson = { raw: text };
    }
    if (writeRes.status === 200 && writeJson?.changes >= 1) {
      writeOk = true;
      break;
    }
    if (writeRes.status === 403 || writeRes.status === 404) {
      break;
    }
    await sleep(5_000);
  }

  record(
    "http-db-write",
    writeOk,
    writeOk
      ? `changes=${writeJson?.changes}`
      : JSON.stringify(writeJson).slice(0, 160),
  );

  if (!writeOk) {
    record(
      "http-db-query",
      false,
      "skipped — write failed (app may need cloud sync: data-sources.json + databases.json in git)",
    );
    record(
      "http-remote-verify",
      false,
      "skipped",
    );
    return;
  }

  const queryRes = await fetch(`${hostBase}/api/db/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      appId: httpFixture.appId,
      sourceId,
      sql: "SELECT label FROM e2e_items WHERE label = ?",
      params: [label],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const queryJson = await queryRes.json().catch(() => ({}));
  record(
    "http-db-query",
    queryRes.ok && queryJson?.count === 1,
    queryRes.ok ? `count=${queryJson?.count}` : JSON.stringify(queryJson).slice(0, 120),
  );

  const remote = await remoteQuery(
    creds,
    `SELECT label FROM e2e_items WHERE label = '${label.replace(/'/g, "''")}'`,
  );
  record(
    "http-remote-verify",
    remote.rows.length === 1,
    `remoteRows=${remote.rows.length}`,
  );
}

async function runSandboxTursoDirect(access, workspace, fixture, creds) {
  console.log("\n--- C. Cloud sandbox — Turso-direct env read/write ---\n");

  const sandboxRoot = path.join(
    os.tmpdir(),
    "papr-cloud-run",
    `plan-a-e2e-${Date.now().toString(36)}`,
  );
  const sandboxHome = path.join(sandboxRoot, "Papr");
  const origHome = process.env.PAPR_HOME;
  const origGatewayMode = process.env.GATEWAY_MODE;

  const {
    shouldUseCloudSandboxTursoDirect,
    tursoCredsByDbIdFromCloudSources,
  } = await importDist("gateway/services/cloudAgentGateway/cloudSandboxTursoDirect.js");
  const { resolveJobWriteTargets, jobWriteDatabaseEnv } = await importDist(
    "gateway/services/jobAppDatabase.js",
  );

  try {
    await fs.promises.mkdir(path.join(sandboxHome, "data"), { recursive: true });
    const dbRecord = fixture.registry.databases[fixture.dbId];
    await fs.promises.writeFile(
      path.join(sandboxHome, "data", "databases.json"),
      `${JSON.stringify({ version: 1, databases: { [fixture.dbId]: dbRecord } }, null, 2)}\n`,
      "utf8",
    );

    process.env.PAPR_HOME = sandboxHome;
    process.env.GATEWAY_MODE = "cloud_agent";
    process.env.PAPR_ORG_ID = workspace.orgId;
    process.env.PAPR_NAMESPACE_ID = workspace.namespaceId;
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
    delete process.env.PAPR_CLOUD_SANDBOX_TURSO_DIRECT;

    record(
      "sandbox-turso-direct-flag",
      shouldUseCloudSandboxTursoDirect(sandboxHome),
      sandboxHome,
    );

    await reloadRegistry();
    await seedRemoteSchema(creds);

    const tursoSources = [
      {
        syncKey: fixture.dbId,
        dbPath: fixture.localPath,
        databaseShortName: fixture.tursoShortName,
        databaseUrl: creds.tursoUrl,
        authToken: creds.authToken,
      },
    ];

    const targets = await resolveJobWriteTargets(
      { writeDbIds: [fixture.dbId], appIds: [] },
      {
        actingUserId: "sandbox-e2e-user",
        tursoCredsByDbId: tursoCredsByDbIdFromCloudSources(tursoSources),
      },
    );

    record(
      "sandbox-resolve-turso-creds",
      targets.length === 1 && targets[0]?.turso?.url === creds.tursoUrl,
      targets[0]?.turso?.url ?? "missing",
    );

    const env = jobWriteDatabaseEnv(targets, fixture.appId);
    record(
      "sandbox-env-mode",
      env.PAPR_DB_MODE === "turso" && env.PAPR_DB_URL === creds.tursoUrl,
      `mode=${env.PAPR_DB_MODE}`,
    );

    const { createClient } = await import("@libsql/client");
    const client = createClient({
      url: env.PAPR_DB_URL,
      authToken: env.PAPR_DB_AUTH_TOKEN,
    });

    const label = `sandbox-direct-${Date.now().toString(36)}`;
    try {
      const insert = await client.execute({
        sql: "INSERT INTO e2e_items (label) VALUES (?)",
        args: [label],
      });
      record(
        "sandbox-libsql-write",
        insert.rowsAffected === 1,
        `rowsAffected=${insert.rowsAffected}`,
      );

      const read = await client.execute({
        sql: "SELECT label FROM e2e_items WHERE label = ?",
        args: [label],
      });
      record(
        "sandbox-libsql-read",
        read.rows.length === 1,
        `rows=${read.rows.length}`,
      );
    } finally {
      client.close();
    }

    const remote = await remoteQuery(
      creds,
      `SELECT label FROM e2e_items WHERE label = '${label.replace(/'/g, "''")}'`,
    );
    record(
      "sandbox-remote-verify",
      remote.rows.length === 1,
      `remoteRows=${remote.rows.length}`,
    );
  } finally {
    if (origHome !== undefined) {
      process.env.PAPR_HOME = origHome;
    } else {
      delete process.env.PAPR_HOME;
    }
    if (origGatewayMode !== undefined) {
      process.env.GATEWAY_MODE = origGatewayMode;
    } else {
      delete process.env.GATEWAY_MODE;
    }
    await fs.promises.rm(sandboxRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function runSandboxToCloudAppHost(access, workspace, httpFixture, creds) {
  console.log("\n--- D. Sandbox → Cloud App Host — read + SSE on db-changed ---\n");

  if (!hostBase) {
    record("sandbox-to-host", true, "skipped (--skip-http)");
    return;
  }

  process.env.PAPR_CLOUD_APP_HOST_KEY =
    process.env.PAPR_CLOUD_APP_HOST_KEY?.trim() || "plan-a-e2e-host-key";

  if (!process.env.PAPR_API_KEY?.trim()) {
    await resolvePaprApiKey(REPO_ROOT);
  }
  const session = await resolvePaprSessionCredentials(REPO_ROOT);
  if (!session?.sessionToken) {
    record(
      "sandbox-host-session",
      false,
      "Papr session required — sign in via Papr Work",
    );
    return;
  }
  record("sandbox-host-session", true, `userId=${session.userId}`);

  let hostOk = false;
  try {
    const health = await fetch(`${hostBase}/health`, { signal: AbortSignal.timeout(5_000) });
    hostOk = health.ok;
  } catch (error) {
    record(
      "sandbox-host-reachable",
      false,
      `${error instanceof Error ? error.message : error}`,
    );
    return;
  }
  record("sandbox-host-reachable", hostOk, hostBase);

  if (!httpFixture.appId) {
    record("sandbox-host-app", false, "fixture missing appId");
    return;
  }

  record(
    "sandbox-host-replica-mode",
    httpFixture.registry.databases[httpFixture.dbId]?.syncMode === "replica",
    `syncMode=${httpFixture.registry.databases[httpFixture.dbId]?.syncMode ?? "unknown"}`,
  );

  const sync = await tryGatewayAppSync(httpFixture.appId);
  if (sync.ok) {
    console.log("  … waiting for git sync (up to 15s)");
    await sleep(15_000);
  }

  const slug = `plan-a-sandbox-${Date.now().toString(36)}`;
  const publish = await publishThrowawayApp(access, httpFixture.appId, slug);
  if (publish.status !== 200) {
    record("sandbox-host-publish", false, publish.text.slice(0, 200));
    return;
  }
  record("sandbox-host-publish", true, `slug=${slug}`);

  const headers = {
    "Content-Type": "application/json",
    "X-Papr-Namespace-Id": workspace.namespaceId,
    "X-Papr-Slug": slug,
    "X-Session-Token": session.sessionToken,
    "X-Papr-External-User-Id": session.userId,
  };
  if (process.env.PAPR_API_KEY?.trim()) {
    headers["X-API-Key"] = process.env.PAPR_API_KEY.trim();
  }

  const sourceId = httpFixture.slug;
  const label = `sandbox-to-host-${Date.now().toString(36)}`;
  const sseUrl = `${hostBase}/api/jobs/events?dbIds=${encodeURIComponent(httpFixture.dbId)}`;

  const ssePromise = waitForSseEvent(sseUrl, {
    eventType: "jobs:db-changed",
    dbId: httpFixture.dbId,
    timeoutMs: 25_000,
  }).catch((error) => ({
    error: error instanceof Error ? error.message : String(error),
  }));

  await sleep(500);

  const wrote = await sandboxLibsqlWrite(access, workspace, httpFixture, creds, label);
  record("sandbox-to-host-write", wrote, label);

  const notify = await notifyCloudHostDbChanged(hostBase, {
    dbId: httpFixture.dbId,
    tables: ["e2e_items"],
  });
  record(
    "sandbox-host-db-changed-notify",
    notify.ok,
    notify.ok ? "ok" : `${notify.status} ${notify.text.slice(0, 120)}`,
  );

  const sseResult = await ssePromise;
  if ("error" in sseResult) {
    record("sandbox-host-sse", false, sseResult.error);
  } else {
    record(
      "sandbox-host-sse",
      sseResult.type === "jobs:db-changed" && sseResult.data?.dbId === httpFixture.dbId,
      JSON.stringify(sseResult.data).slice(0, 120),
    );
  }

  let queryOk = false;
  let queryJson = null;
  const queryDeadline = Date.now() + 60_000;
  while (Date.now() < queryDeadline) {
    const queryRes = await fetch(`${hostBase}/api/db/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        appId: httpFixture.appId,
        sourceId,
        sql: "SELECT label FROM e2e_items WHERE label = ?",
        params: [label],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    queryJson = await queryRes.json().catch(() => ({}));
    if (queryRes.ok && queryJson?.count === 1) {
      queryOk = true;
      break;
    }
    if (queryRes.status === 403 || queryRes.status === 404) {
      break;
    }
    await sleep(3_000);
  }

  record(
    "sandbox-host-app-read",
    queryOk,
    queryOk ? `label=${label}` : JSON.stringify(queryJson).slice(0, 160),
  );

  const remote = await remoteQuery(
    creds,
    `SELECT label FROM e2e_items WHERE label = '${label.replace(/'/g, "''")}'`,
  );
  record(
    "sandbox-host-remote-verify",
    remote.rows.length === 1,
    `remoteRows=${remote.rows.length}`,
  );
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Open fixture.localPath as embedded replica and pull current Turso head (keeps file). */
async function ensureLocalReplicaSynced(creds, localPath) {
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
    "local-replica-sync",
  );
  await db.pull();
  await db.close();
}

async function runDesktopReplicaLoop(access, workspace, fixture, creds) {
  console.log("\n--- E. Desktop replica loop — pull after cloud/sandbox writes ---\n");

  const { initializeTursoSyncBridge } = await importDist(
    "gateway/services/TursoSyncBridge.js",
  );
  const bridge = initializeTursoSyncBridge();
  patchBridgeCredentials(bridge, access);

  const { paprDbPull, paprDbExec } = await importDist(
    "gateway/services/tursoReplica/PaprDbService.js",
  );
  const { queryLinkedDbViaTursoReplica } = await importDist(
    "gateway/services/tursoReplica/tursoReplicaRouting.js",
  );
  const { setTursoReplicaOnlineForTests } = await importDist(
    "gateway/utils/tursoReplicaEnabled.js",
  );

  await reloadRegistry();
  setTursoReplicaOnlineForTests(true);
  await resetReplicaConnections();

  await seedRemoteSchema(creds);
  await ensureLocalReplicaSynced(creds, fixture.localPath);

  const source = makeSource(fixture.dbId, fixture.slug, fixture.localPath, fixture.now);

  // Cloud host / remote writer → desktop pull → local read
  const cloudLabel = `cloud-to-desktop-${Date.now().toString(36)}`;
  await remoteExec(
    creds,
    `INSERT INTO e2e_items (label) VALUES (${sqlLiteral(cloudLabel)})`,
  );

  const beforeCloudPull = await queryLinkedDbViaTursoReplica(
    source,
    "SELECT label FROM e2e_items WHERE label = ?",
    [cloudLabel],
    { pullBeforeRead: false },
  );
  record(
    "desktop-local-missing-before-cloud-pull",
    beforeCloudPull.count === 0,
    `localCount=${beforeCloudPull.count}`,
  );

  const cloudPull = await paprDbPull({ dbId: fixture.dbId });
  const afterCloudPull = await queryLinkedDbViaTursoReplica(
    source,
    "SELECT label FROM e2e_items WHERE label = ?",
    [cloudLabel],
    { pullBeforeRead: false },
  );
  record(
    "desktop-pull-after-cloud-write",
    afterCloudPull.count === 1,
    `pulled=${cloudPull.pulled} localCount=${afterCloudPull.count}`,
  );

  // Sandbox Turso-direct writer → desktop pull → local read
  const sandboxLabel = `sandbox-to-desktop-${Date.now().toString(36)}`;
  const sandboxWrote = await sandboxLibsqlWrite(
    access,
    workspace,
    fixture,
    creds,
    sandboxLabel,
  );
  record("desktop-sandbox-remote-write", sandboxWrote, sandboxLabel);

  await reloadRegistry();

  const beforeSandboxPull = await queryLinkedDbViaTursoReplica(
    source,
    "SELECT label FROM e2e_items WHERE label = ?",
    [sandboxLabel],
    { pullBeforeRead: false },
  );
  record(
    "desktop-local-missing-before-sandbox-pull",
    beforeSandboxPull.count === 0,
    `localCount=${beforeSandboxPull.count}`,
  );

  const sandboxPull = await paprDbPull({ dbId: fixture.dbId });
  const afterSandboxPull = await queryLinkedDbViaTursoReplica(
    source,
    "SELECT label FROM e2e_items WHERE label = ?",
    [sandboxLabel],
    { pullBeforeRead: false },
  );
  record(
    "desktop-pull-after-sandbox-write",
    afterSandboxPull.count === 1,
    `pulled=${sandboxPull.pulled} localCount=${afterSandboxPull.count}`,
  );

  // Desktop write → Turso primary (reverse)
  const desktopLabel = `desktop-to-cloud-${Date.now().toString(36)}`;
  const desktopWrite = await paprDbExec({
    dbId: fixture.dbId,
    sql: "INSERT INTO e2e_items (label) VALUES (?)",
    params: [desktopLabel],
  });
  const desktopRemote = await remoteQuery(
    creds,
    `SELECT label FROM e2e_items WHERE label = ${sqlLiteral(desktopLabel)}`,
  );
  record(
    "desktop-write-to-turso-primary",
    desktopWrite.changes === 1 &&
      desktopWrite.backend === "turso-replica" &&
      desktopWrite.pendingPush === false &&
      desktopRemote.rows.length === 1,
    `changes=${desktopWrite.changes} pendingPush=${desktopWrite.pendingPush} remoteRows=${desktopRemote.rows.length}`,
  );

  setTursoReplicaOnlineForTests(null);
}

async function main() {
  console.log("\n=== Plan A Turso Direct — Local E2E ===\n");
  loadEnvLocal(REPO_ROOT);

  const access = await requireReplicaE2eAccess();
  const workspace = readActiveWorkspace();
  applyReplicaE2eEnv(workspace);
  console.log(`Workspace: ${workspace.paprHome}`);
  if (hostBase) {
    console.log(`Cloud App Host: ${hostBase}`);
  }
  console.log("");

  let fixture = null;
  let httpFixture = null;

  try {
    fixture = await createThrowawayFixture(access, { withApp: false });
    httpFixture = await createThrowawayFixture(access, { withApp: true });

    console.log(`Adapter DB: ${fixture.dbId} (${fixture.slug})`);
    console.log(`HTTP app:   ${httpFixture.appId} / ${httpFixture.dbId}\n`);

    const adapterCreds = await fetchTursoCredentials(access, fixture.tursoDatabase);
    await provisionTursoReplica(adapterCreds, `${fixture.localPath}.plan-a-provision`);

    const httpCreds = await fetchTursoCredentials(access, httpFixture.tursoDatabase);
    await provisionTursoReplica(httpCreds, `${httpFixture.localPath}.plan-a-http-provision`);
    await seedRemoteSchema(httpCreds);

    await runTursoDbAdapterDirectWrite(access, workspace, fixture, adapterCreds);
    await runCloudAppHostHttp(access, workspace, httpFixture, httpCreds);
    await runSandboxTursoDirect(access, workspace, fixture, adapterCreds);
    await runSandboxToCloudAppHost(access, workspace, httpFixture, httpCreds);
    await runDesktopReplicaLoop(access, workspace, fixture, adapterCreds);
  } finally {
    if (httpFixture) {
      await destroyThrowawayFixture(httpFixture);
    }
    if (fixture) {
      await destroyThrowawayFixture(fixture);
      console.log("\nRestored workspace fixtures");
    }
  }

  const allPass = printSummary();
  process.exit(allPass ? 0 : 1);
}

main().catch((error) => {
  console.error("PLAN_A_TURSO_DIRECT_E2E_FATAL:", error instanceof Error ? error.message : error);
  process.exit(1);
});
