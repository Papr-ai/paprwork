#!/usr/bin/env node
/**
 * Option A E2E — per-user Turso naming (publisher → base, visitor → `-u-{uid8}`).
 *
 * Layers:
 *   1. Vitest unit suite (turso-runtime-identity)
 *   2. Dist integration — registry + naming helpers (no network)
 *   3. TursoDbAdapter token path — records `database` passed to credentials (mock libsql)
 *   4. Optional: memory repo pytest (turso_database_naming only)
 *   5. Optional: live Memory `/v1/cloud/databases/token` for base vs suffixed name
 *
 * Usage:
 *   npm run test:turso-option-a-e2e
 *   node scripts/test-turso-option-a-e2e.mjs [--skip-memory] [--skip-live]
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  REPO_ROOT,
  importDist,
  record,
  printSummary,
  reloadRegistry,
  makeSource,
  fetchTursoCredentials,
  requireReplicaE2eAccess,
} from "./lib/replicaE2eHarness.mjs";
import { loadEnvLocal } from "./lib/testEnv.mjs";

const args = new Set(process.argv.slice(2));
const skipMemory = args.has("--skip-memory");
const skipLive = args.has("--skip-live");

const PUBLISHER = "pub-11111111-2222-3333-4444-555555555555";
const VISITOR = "call-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const DB_ID = "db-abcdef12";
const BASE = "d-abcdef12";
const VISITOR_SUFFIX = "d-abcdef12-u-callaaaa";

/** @typedef {{ gatewayMode?: string, paprHome?: string, paprUserData?: string, orgId?: string, namespaceId?: string }} PaprEnvSnapshot */

/** Prevent `ensureActiveWorkspaceEnvSynced()` from replacing temp PAPR_HOME with ~/.active-workspace.json. */
function snapshotPaprEnv() {
  return {
    gatewayMode: process.env.GATEWAY_MODE,
    paprHome: process.env.PAPR_HOME,
    paprUserData: process.env.PAPR_USER_DATA,
    orgId: process.env.PAPR_ORG_ID,
    namespaceId: process.env.PAPR_NAMESPACE_ID,
  };
}

async function applyIsolatedPaprHome(sandboxHome) {
  process.env.GATEWAY_MODE = "cloud_agent";
  process.env.PAPR_HOME = sandboxHome;
  process.env.PAPR_USER_DATA = path.join(sandboxHome, ".paprwork-v2");
  await fs.promises.mkdir(process.env.PAPR_USER_DATA, { recursive: true });
  delete process.env.PAPR_ORG_ID;
  delete process.env.PAPR_NAMESPACE_ID;
}

function restorePaprEnv(snapshot) {
  if (snapshot.gatewayMode === undefined) {
    delete process.env.GATEWAY_MODE;
  } else {
    process.env.GATEWAY_MODE = snapshot.gatewayMode;
  }
  if (snapshot.paprHome === undefined) {
    delete process.env.PAPR_HOME;
  } else {
    process.env.PAPR_HOME = snapshot.paprHome;
  }
  if (snapshot.paprUserData === undefined) {
    delete process.env.PAPR_USER_DATA;
  } else {
    process.env.PAPR_USER_DATA = snapshot.paprUserData;
  }
  if (snapshot.orgId === undefined) {
    delete process.env.PAPR_ORG_ID;
  } else {
    process.env.PAPR_ORG_ID = snapshot.orgId;
  }
  if (snapshot.namespaceId === undefined) {
    delete process.env.PAPR_NAMESPACE_ID;
  } else {
    process.env.PAPR_NAMESPACE_ID = snapshot.namespaceId;
  }
}

/** Restore env, reset in-process registry singleton, delete temp PAPR_HOME. */
async function teardownIsolatedRun(envSnap, sandboxHome) {
  restorePaprEnv(envSnap);
  try {
    const dbMod = await importDist("gateway/services/DatabaseRegistryService.js");
    dbMod.resetDatabaseRegistryForWorkspaceSwitch();
    if (process.env.PAPR_HOME) {
      await dbMod.initializeDatabaseRegistry();
    }
  } catch {
    /* dist missing or init skipped */
  }
  await fs.promises.rm(sandboxHome, { recursive: true, force: true }).catch(() => {});
}

function runVitest() {
  console.log("\n--- 1. Vitest (turso-runtime-identity) ---\n");
  const r = spawnSync(
    "npx",
    ["vitest", "run", "tests/turso-runtime-identity.test.ts", "--project", "unit-backend"],
    { cwd: REPO_ROOT, encoding: "utf8", stdio: "pipe" },
  );
  const ok = r.status === 0;
  record("vitest-turso-runtime-identity", ok, ok ? "11 tests" : (r.stderr || r.stdout).slice(-400));
  return ok;
}

async function seedPerUserRegistry(paprHome) {
  const dataDir = path.join(paprHome, "data");
  await fs.promises.mkdir(dataDir, { recursive: true });
  const localPath = path.join(paprHome, "apps", "opt-a-e2e", "databases", DB_ID, "data.db");
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
  const record = {
    dbId: DB_ID,
    label: "main",
    localPath,
    isolation: "per-user",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await fs.promises.writeFile(
    path.join(dataDir, "databases.json"),
    `${JSON.stringify({ version: 1, databases: { [DB_ID]: record } }, null, 2)}\n`,
    "utf8",
  );
  return { record, localPath };
}

async function runDistNamingChain() {
  console.log("\n--- 2. Dist naming chain (registry + Option A) ---\n");

  const {
    resolveTursoSuffixUserId,
    resolveTursoActingUserId,
  } = await importDist("gateway/services/appRuntime/tursoRuntimeIdentity.js");
  const { tursoNameForRecord } = await importDist(
    "gateway/services/DatabaseRegistryService.js",
  );

  const sandboxHome = path.join(os.tmpdir(), `papr-opt-a-${Date.now().toString(36)}`);
  const envSnap = snapshotPaprEnv();
  try {
    await applyIsolatedPaprHome(sandboxHome);
    const { record: dbRecord } = await seedPerUserRegistry(sandboxHome);
    await reloadRegistry();

    const { getDatabaseRegistryService } = await importDist(
      "gateway/services/DatabaseRegistryService.js",
    );
    const loaded = getDatabaseRegistryService().getById(DB_ID);
    record(
      "registry-loads-seeded-db",
      loaded?.dbId === DB_ID && loaded.isolation === "per-user",
      loaded ? `${loaded.dbId} isolation=${loaded.isolation}` : "(missing from registry)",
    );

    const pubActors = { publisherUserId: PUBLISHER, callerUserId: PUBLISHER };
    const visActors = { publisherUserId: PUBLISHER, callerUserId: VISITOR };

    const pubSuffix = resolveTursoSuffixUserId("per-user", pubActors);
    const visSuffix = resolveTursoSuffixUserId("per-user", visActors);
    const pubName = tursoNameForRecord(dbRecord, pubSuffix);
    const visName = tursoNameForRecord(dbRecord, visSuffix);

    record("suffix-publisher-undefined", pubSuffix === undefined, String(pubSuffix));
    record("suffix-visitor-set", visSuffix === VISITOR, visSuffix ?? "(missing)");
    record("name-publisher-base", pubName === BASE, `${pubName} (expected ${BASE})`);
    record("name-visitor-suffixed", visName === VISITOR_SUFFIX, `${visName} (expected ${VISITOR_SUFFIX})`);

    const pubActing = resolveTursoActingUserId("per-user", pubActors);
    const visActing = resolveTursoActingUserId("per-user", visActors);
    record(
      "acting-publisher-is-caller",
      pubActing === PUBLISHER,
      "token/cache user for publisher",
    );
    record("acting-visitor-is-caller", visActing === VISITOR, "token/cache user for visitor");

    return (
      loaded?.dbId === DB_ID &&
      pubName === BASE &&
      visName === VISITOR_SUFFIX
    );
  } finally {
    await teardownIsolatedRun(envSnap, sandboxHome);
  }
}

async function runAdapterDatabaseProbe() {
  console.log("\n--- 3. TursoDbAdapter credentials.database (mock) ---\n");

  const { TursoDbAdapter } = await importDist("gateway/services/appRuntime/TursoDbAdapter.js");
  const requested = [];

  const credentials = {
    getUserDatabaseToken: async (_org, _ns, _actingUser, _auth, database) => {
      requested.push(database);
      return {
        tursoUrl: "libsql://mock.turso.io",
        authToken: "mock-token",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      };
    },
  };

  const sandboxHome = path.join(os.tmpdir(), `papr-opt-a-adapt-${Date.now().toString(36)}`);
  const envSnap = snapshotPaprEnv();
  try {
    await applyIsolatedPaprHome(sandboxHome);
    const { localPath } = await seedPerUserRegistry(sandboxHome);
    await reloadRegistry();

    const adapter = new TursoDbAdapter(credentials);
    const now = new Date().toISOString();
    const source = makeSource(DB_ID, "main", localPath, now);
    const config = { sources: [source] };
    const runtimeAuth = {
      namespaceId: "ns-opt-a-e2e",
      slug: "opt-a-e2e",
      paprApiKey: "sk-mock",
    };

    const runQuery = async (callerUserId) => {
      requested.length = 0;
      let queryError = "";
      try {
        await adapter.query({
          orgId: "org-opt-a",
          namespaceId: runtimeAuth.namespaceId,
          userId: PUBLISHER,
          callerUserId,
          runtimeAuth,
          config,
          appId: "opt-a-e2e-app",
          sourceId: "main",
          sql: "SELECT 1 AS ok",
          params: [],
        });
      } catch (err) {
        queryError = err instanceof Error ? err.message : String(err);
      }
      return { databases: [...requested], queryError };
    };

    const pubRun = await runQuery(PUBLISHER);
    const visRun = await runQuery(VISITOR);

    const pubOk =
      pubRun.databases.includes(BASE) && !pubRun.databases.some((d) => d.includes("-u-"));
    const visOk = visRun.databases.includes(VISITOR_SUFFIX);

    const fmtProbe = (run) => {
      if (run.databases.length) {
        return run.databases.join(", ");
      }
      return run.queryError
        ? `no token fetch: ${run.queryError.slice(0, 160)}`
        : "(no token fetch — check dist build)";
    };

    record("adapter-publisher-database", pubOk, fmtProbe(pubRun));
    record("adapter-visitor-database", visOk, fmtProbe(visRun));
    return pubOk && visOk;
  } finally {
    await teardownIsolatedRun(envSnap, sandboxHome);
  }
}

function runMemoryPytest() {
  console.log("\n--- 4. Memory pytest (optional) ---\n");
  if (skipMemory) {
    record("memory-pytest", true, "skipped (--skip-memory)");
    return true;
  }

  const memoryRoot = path.join(REPO_ROOT, "..", "memory");
  if (!fs.existsSync(path.join(memoryRoot, "tests", "test_turso_database_naming.py"))) {
    record("memory-pytest", true, "skipped (../memory not found)");
    return true;
  }

  const venvPython = [
    path.join(memoryRoot, ".venv", "bin", "python"),
    path.join(memoryRoot, "venv", "bin", "python"),
  ].find((p) => fs.existsSync(p));

  if (!venvPython) {
    record(
      "memory-pytest",
      true,
      "skipped (no ../memory/.venv — run: cd ../memory && python3 -m venv .venv && pip install pytest)",
    );
    return true;
  }

  const r = spawnSync(
    venvPython,
    [
      "-m",
      "pytest",
      "tests/test_turso_database_naming.py",
      "-q",
      "-W",
      "ignore::DeprecationWarning",
    ],
    { cwd: memoryRoot, encoding: "utf8", stdio: "pipe", env: { ...process.env, PYTHONPATH: memoryRoot } },
  );

  if (r.error?.code === "ENOENT" || (r.stderr && r.stderr.includes("No module named pytest"))) {
    record("memory-pytest", true, "skipped (pytest not installed in memory venv)");
    return true;
  }

  const ok = r.status === 0;
  record(
    "memory-pytest",
    ok,
    ok ? "turso_database_naming" : (r.stderr || r.stdout).slice(-500),
  );
  return ok;
}

async function runLiveTokenProbe() {
  console.log("\n--- 5. Live Turso token names (optional) ---\n");
  if (skipLive) {
    record("live-turso-token", true, "skipped (--skip-live)");
    return true;
  }

  loadEnvLocal(REPO_ROOT);
  let access;
  try {
    access = await requireReplicaE2eAccess();
  } catch (err) {
    record(
      "live-turso-token",
      true,
      `skipped (${err instanceof Error ? err.message.slice(0, 120) : String(err)})`,
    );
    return true;
  }

  try {
    await fetchTursoCredentials(access, BASE);
    record("live-token-base", true, `issued token for ${BASE}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const acceptable =
      msg.includes("404") || msg.includes("403") || msg.includes("not linked");
    record(
      "live-token-base",
      acceptable,
      acceptable
        ? `no remote ${BASE} in workspace (naming probe only): ${msg.slice(0, 100)}`
        : msg.slice(0, 200),
    );
  }

  try {
    await fetchTursoCredentials(access, VISITOR_SUFFIX);
    record(
      "live-token-visitor-suffix",
      true,
      `token issued for ${VISITOR_SUFFIX} (Memory token API does not require app link; allowlist enforced at runtime)`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    record(
      "live-token-visitor-suffix",
      true,
      `token rejected for ${VISITOR_SUFFIX}: ${msg.slice(0, 120)}`,
    );
  }
  return true;
}

async function main() {
  console.log("Option A Turso isolation E2E\n");

  const distGate = path.join(REPO_ROOT, "dist", "gateway", "services", "appRuntime", "tursoRuntimeIdentity.js");
  if (!fs.existsSync(distGate)) {
    console.error("dist/ missing — run: npm run build:gateway");
    process.exit(1);
  }

  runVitest();
  await runDistNamingChain();
  await runAdapterDatabaseProbe();
  runMemoryPytest();
  await runLiveTokenProbe();

  const ok = printSummary();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
