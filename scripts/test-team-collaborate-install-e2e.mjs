#!/usr/bin/env node
/**
 * Team collaborate install E2E — track + shared publisher DB vs fork.
 *
 * Prerequisites:
 *   1. Memory server with /v1/cloud/apps/install/db-token (PAPR_MEMORY_SERVER_URL)
 *   2. npm run build:gateway (imports dist/gateway/services/*)
 *   3. PAPR_API_KEY in .env.local or Papr Work keychain
 *   4. Published team app with shared registry DB (visibility: team, codeAccess: install)
 *
 * Usage:
 *   npm run test:team-collaborate-install
 *   node scripts/test-team-collaborate-install-e2e.mjs \
 *     --namespace=VIA2C5VDxj --slug=myadvice-gtm-metrics --app-id=91d94d77-...
 */

import { execSync } from "child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import {
  loadEnvLocal,
  resolvePaprApiKey,
} from "./lib/testEnv.mjs";

const args = process.argv.slice(2);
const appId =
  args.find((a) => a.startsWith("--app-id="))?.split("=")[1] ??
  "91d94d77-dace-4746-8be4-2f7e385c6944";
const publisherUser =
  args.find((a) => a.startsWith("--publisher-user="))?.split("=")[1] ??
  "WkPutXGdqg";
const teammateUser =
  args.find((a) => a.startsWith("--teammate-user="))?.split("=")[1] ??
  "l6UFSw9m4T";
const namespaceId =
  args.find((a) => a.startsWith("--namespace="))?.split("=")[1] ??
  "VIA2C5VDxj";
const slug =
  args.find((a) => a.startsWith("--slug="))?.split("=")[1] ??
  "myadvice-gtm-metrics";
const skipCleanup = args.includes("--no-cleanup");
const skipFork = args.includes("--skip-fork");

const GREEN = "\x1b[92m";
const RED = "\x1b[91m";
const YELLOW = "\x1b[93m";
const CYAN = "\x1b[96m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ${GREEN}PASS${RESET} ${name}`);
    passed++;
  } else {
    console.log(`  ${RED}FAIL${RESET} ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

async function memoryFetch(memoryBase, apiKey, path, { userId, method = "GET", body = null } = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const url =
    method === "GET" || method === "HEAD"
      ? `${memoryBase}${path}${sep}external_user_id=${encodeURIComponent(userId)}`
      : `${memoryBase}${path}`;
  const opts = {
    method,
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
    },
  };
  if (body && method !== "GET") {
    opts.body = JSON.stringify({ ...body, external_user_id: userId });
  }
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: resp.status, data, text };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function registryDbIdsFromHome(paprHome) {
  const raw = readFileSync(join(paprHome, "data", "databases.json"), "utf8");
  const parsed = JSON.parse(raw);
  return Object.keys(parsed.databases ?? {});
}

function primaryDbPathFromApp(paprHome, localAppId) {
  const ds = readJson(join(paprHome, "apps", localAppId, "data-sources.json"));
  const sqlite = ds.sources?.find((s) => s.type === "sqlite" && s.dbId);
  if (!sqlite?.dbPath) {
    return null;
  }
  return sqlite.dbPath.startsWith("/")
    ? sqlite.dbPath
    : join(paprHome, sqlite.dbPath.replace(/^Papr\//, ""));
}

function isDbFilePresent(dbPath) {
  if (!existsSync(dbPath)) {
    return false;
  }
  try {
    return statSync(dbPath).size > 0;
  } catch {
    return false;
  }
}

async function runInstall(paprHome, userId, mode) {
  process.env.PAPR_HOME = paprHome;
  process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID = userId;
  process.env.PAPR_API_KEY = apiKey;
  process.env.PAPR_MEMORY_SERVER_URL = memoryBase;
  process.env.CLOUD_SYNC_ENABLED = "false";
  process.env.GATEWAY_MODE = "cloud_agent";
  process.env.PAPR_TURSO_REPLICA_SYNC = process.env.PAPR_TURSO_REPLICA_SYNC ?? "replica-records";

  const installMod = await import(
    pathToFileURL(
      join(process.cwd(), "dist/gateway/services/CloudAppInstallService.js"),
    ).href
  );
  return installMod.getCloudAppInstallService().installApp({
    namespaceId,
    slug,
    mode,
    catalogScope: "namespace",
    visibility: "team",
  });
}

async function runTrackSync(paprHome, userId, localAppId) {
  process.env.PAPR_HOME = paprHome;
  process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID = userId;
  process.env.PAPR_API_KEY = apiKey;
  process.env.PAPR_MEMORY_SERVER_URL = memoryBase;
  process.env.GATEWAY_MODE = "cloud_agent";

  const trackMod = await import(
    pathToFileURL(
      join(process.cwd(), "dist/gateway/services/CloudAppTrackSyncService.js"),
    ).href
  );
  return trackMod.getCloudAppTrackSyncService().syncTrackApp(localAppId);
}

function seedWorkspace(paprHome) {
  mkdirSync(join(paprHome, "data"), { recursive: true });
  mkdirSync(join(paprHome, "apps"), { recursive: true });
  mkdirSync(join(paprHome, "Jobs"), { recursive: true });
  writeFileSync(join(paprHome, "data", "apps.json"), "[]\n");
  writeFileSync(join(paprHome, "data", "jobs.json"), "[]\n");
  writeFileSync(
    join(paprHome, "data", "databases.json"),
    JSON.stringify({ version: 1, databases: {} }, null, 2),
  );
}

let apiKey = "";
/** Cloud memory used for install/publish (production or PAPR_MEMORY_SERVER_URL). */
let memoryBase = "";
/** Local dev memory — verify restarted server exposes install/db-token. */
let localMemoryBase = "";

async function main() {
  loadEnvLocal();
  console.log(`\n${BOLD}${CYAN}Team Collaborate Install E2E${RESET}`);
  console.log(`App:       ${appId} (${slug})`);
  console.log(`Namespace: ${namespaceId}`);
  console.log("=".repeat(60));

  const resolved = await resolvePaprApiKey();
  if (!resolved?.key) {
    console.error(
      `${RED}PAPR_API_KEY required — set in .env.local or login via Papr Work keychain${RESET}`,
    );
    process.exit(1);
  }
  apiKey = resolved.key;
  localMemoryBase = (
    process.env.PAPR_MEMORY_LOCAL_URL ?? "http://127.0.0.1:5001"
  ).replace(/\/$/, "");
  const envMemory = process.env.PAPR_MEMORY_SERVER_URL?.replace(/\/$/, "");
  memoryBase = "https://memory.papr.ai";
  if (
    envMemory &&
    !/localhost|127\.0\.0\.1/.test(envMemory) &&
    process.env.PAPR_MEMORY_E2E_USE_CLOUD !== "1"
  ) {
    memoryBase = envMemory;
  }
  console.log(`API key: ${apiKey.slice(0, 24)}... (${resolved.source})`);

  console.log(`\n${BOLD}--- Local memory server ---${RESET}`);
  let localMemoryHealthy = false;
  try {
    const health = await fetch(`${localMemoryBase}/health`);
    localMemoryHealthy = health.status === 200;
    check("local /health → 200", localMemoryHealthy, `status=${health.status}`);
  } catch (e) {
    check("local memory reachable", false, e.message);
  }

  if (
    localMemoryHealthy &&
    process.env.PAPR_MEMORY_E2E_USE_CLOUD !== "1"
  ) {
    memoryBase = localMemoryBase;
    console.log(`${CYAN}Using local memory for install + db-token: ${memoryBase}${RESET}`);
  } else {
    console.log(`Using cloud memory for install: ${memoryBase}`);
  }

  const routeProbe = await fetch(`${localMemoryBase}/v1/cloud/apps/install/db-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ namespaceId, slug, database: "d-test0000" }),
  });
  check(
    "local install/db-token route exists (not 404)",
    routeProbe.status !== 404,
    `status=${routeProbe.status}`,
  );

  console.log(`\n${BOLD}--- Install memory server ---${RESET}`);
  try {
    const installHealth = await fetch(`${memoryBase}/health`);
    check("install memory /health → 200", installHealth.status === 200, `status=${installHealth.status}`);
  } catch (e) {
    check("install memory reachable", false, e.message);
    process.exit(1);
  }

  console.log(`\n${BOLD}--- Publisher publish config ---${RESET}`);
  const pub = await memoryFetch(memoryBase, apiKey, `/v1/cloud/apps/publish/${encodeURIComponent(appId)}`, {
    userId: publisherUser,
  });
  check("publisher can read publish config", pub.status === 200, pub.text.slice(0, 160));
  check("visibility is team", pub.data?.visibility === "team", pub.data?.visibility);
  check("codeAccess=install", pub.data?.codeAccess === "install", pub.data?.codeAccess);

  const distInstall = join(process.cwd(), "dist/gateway/services/CloudAppInstallService.js");
  if (!existsSync(distInstall)) {
    console.log(`\n${YELLOW}Building gateway (dist missing)...${RESET}`);
    execSync("npm run build:gateway", { stdio: "inherit", cwd: process.cwd() });
  }
  check("gateway dist present", existsSync(distInstall), distInstall);

  console.log(`\n${BOLD}--- Teammate track install (shared DB) ---${RESET}`);
  const trackRoot = mkdtempSync(join(tmpdir(), "papr-team-track-e2e-"));
  const trackHome = join(trackRoot, "Papr");
  seedWorkspace(trackHome);

  let trackLocalAppId = null;
  let trackDbPathBeforeSync = null;
  let trackDbMtimeBeforeSync = 0;

  try {
    const trackResult = await runInstall(trackHome, teammateUser, "track");
    trackLocalAppId = trackResult.app?.id ?? null;
    check("track install succeeded", !!trackLocalAppId, JSON.stringify(trackResult.app?.title));
    check("install mode=track", trackResult.mode === "track", trackResult.mode);

    const lineagePath = join(trackHome, "apps", trackLocalAppId, "papr-cloud-lineage.json");
    check("lineage file exists", existsSync(lineagePath), lineagePath);
    const lineage = existsSync(lineagePath) ? readJson(lineagePath) : null;
    check("databasePolicy=shared", lineage?.databasePolicy === "shared", lineage?.databasePolicy);
    check("lineage mode=track", lineage?.mode === "track", lineage?.mode);

    const sharedStorePath = join(trackHome, "data", ".shared-primary-turso.json");
    check("shared-primary turso store exists", existsSync(sharedStorePath), sharedStorePath);
    if (existsSync(sharedStorePath)) {
      const store = readJson(sharedStorePath);
      const keys = Object.keys(store.databases ?? {});
      check("shared-primary has turso entries", keys.length > 0, `count=${keys.length}`);
    }

    trackDbPathBeforeSync = primaryDbPathFromApp(trackHome, trackLocalAppId);
    if (trackDbPathBeforeSync && existsSync(trackDbPathBeforeSync)) {
      trackDbMtimeBeforeSync = statSync(trackDbPathBeforeSync).mtimeMs;
    }
    check(
      "track local sqlite file present",
      trackDbPathBeforeSync ? isDbFilePresent(trackDbPathBeforeSync) : false,
      trackDbPathBeforeSync ?? "no db path",
    );

    const tursoShort =
      registryDbIdsFromHome(trackHome)[0] &&
      readJson(join(trackHome, "data", "databases.json")).databases[
        registryDbIdsFromHome(trackHome)[0]
      ]?.tursoShortName;
    if (tursoShort) {
      const token = await memoryFetch(
        localMemoryBase,
        apiKey,
        "/v1/cloud/apps/install/db-token",
        {
          userId: teammateUser,
          method: "POST",
          body: {
            namespaceId,
            slug,
            database: tursoShort,
          },
        },
      );
      check(
        "teammate install/db-token authorized",
        token.status === 200 && !!token.data?.tursoUrl,
        `status=${token.status} ${token.text.slice(0, 120)}`,
      );
    }

    console.log(`\n${BOLD}--- Teammate track sync (code-only path) ---${RESET}`);
    const sync = await runTrackSync(trackHome, teammateUser, trackLocalAppId);
    check("track sync returns appId", sync.appId === trackLocalAppId, sync.appId);
    if (trackDbPathBeforeSync && existsSync(trackDbPathBeforeSync)) {
      const mtimeAfter = statSync(trackDbPathBeforeSync).mtimeMs;
      check(
        "track sync did not replace sqlite from git (mtime stable or Turso pull only)",
        mtimeAfter >= trackDbMtimeBeforeSync,
        `before=${trackDbMtimeBeforeSync} after=${mtimeAfter}`,
      );
    }
  } catch (error) {
    check("track install/sync block", false, error.message.slice(0, 200));
  }

  if (!skipFork) {
    console.log(`\n${BOLD}--- Teammate fork install (own DB) ---${RESET}`);
    const forkRoot = mkdtempSync(join(tmpdir(), "papr-team-fork-e2e-"));
    const forkHome = join(forkRoot, "Papr");
    seedWorkspace(forkHome);
    try {
      const forkResult = await runInstall(forkHome, teammateUser, "fork");
      const forkAppId = forkResult.app?.id ?? null;
      check("fork install succeeded", !!forkAppId, forkResult.mode);

      const forkLineagePath = join(forkHome, "apps", forkAppId, "papr-cloud-lineage.json");
      const forkLineage = existsSync(forkLineagePath) ? readJson(forkLineagePath) : null;
      check("fork lineage databasePolicy=forked", forkLineage?.databasePolicy === "forked", forkLineage?.databasePolicy);

      const trackDbIds = trackLocalAppId ? registryDbIdsFromHome(trackHome) : [];
      const forkDbIds = registryDbIdsFromHome(forkHome);
      if (trackDbIds.length > 0 && forkDbIds.length > 0) {
        check(
          "fork minted different dbId than track",
          forkDbIds[0] !== trackDbIds[0],
          `track=${trackDbIds[0]} fork=${forkDbIds[0]}`,
        );
      }

      check(
        "fork has no shared-primary store entries",
        !existsSync(join(forkHome, "data", ".shared-primary-turso.json")) ||
          Object.keys(
            readJson(join(forkHome, "data", ".shared-primary-turso.json")).databases ?? {},
          ).length === 0,
        forkHome,
      );

      if (!skipCleanup) {
        rmSync(forkRoot, { recursive: true, force: true });
      } else {
        console.log(`${YELLOW}Fork home: ${forkHome}${RESET}`);
      }
    } catch (error) {
      check("fork install block", false, error.message.slice(0, 200));
    }
  }

  if (!skipCleanup) {
    rmSync(trackRoot, { recursive: true, force: true });
  } else {
    console.log(`\n${YELLOW}Track home left at: ${trackHome}${RESET}`);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(
    `Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`${RED}Fatal:${RESET}`, e);
  process.exit(1);
});
