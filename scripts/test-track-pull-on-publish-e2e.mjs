#!/usr/bin/env node
/**
 * Track pull-on-publish E2E — stale upstreamRevision → pull-on-publish → revision caught up
 *
 * Simulates the track consumer path when an owner publishes a new revision.
 * Uses the same `pullTrackAppsOnPublish()` code path as desktop heartbeat + post-publish.
 *
 * Prerequisites:
 *   1. Paprwork gateway running: npm start (or dist/gateway on :18789)
 *   2. At least one track-mode cloud install in $PAPR_HOME/apps/
 *   3. Published app reachable at apps.papr.ai (live app-revision.json)
 *
 * Usage:
 *   npm run test:track-pull-on-publish-e2e
 *   node scripts/test-track-pull-on-publish-e2e.mjs [--gateway URL] [--app-id ID] [--no-cleanup]
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const args = process.argv.slice(2);
const gateway = (
  args.find((a) => a.startsWith("--gateway="))?.split("=")[1] ??
  "http://localhost:18789"
).replace(/\/$/, "");
const appIdArg = args.find((a) => a.startsWith("--app-id="))?.split("=")[1];
const skipCleanup = args.includes("--no-cleanup");
const pollSeconds = Number(
  args.find((a) => a.startsWith("--poll-seconds="))?.split("=")[1] ?? "60",
);

const GREEN = "\x1b[92m";
const RED = "\x1b[91m";
const YELLOW = "\x1b[93m";
const CYAN = "\x1b[96m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

const LINEAGE_FILENAME = "papr-cloud-lineage.json";

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

function paprHome() {
  return process.env.PAPR_HOME ?? join(homedir(), "Papr");
}

function appsRoot() {
  return join(paprHome(), "apps");
}

function loadEnvLocal() {
  try {
    const raw = readFileSync(join(process.cwd(), ".env.local"), "utf8");
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

function pickTrackAppIdFromDisk() {
  if (appIdArg) return appIdArg;
  try {
    const root = appsRoot();
    for (const appId of readdirSync(root)) {
      const lineagePath = join(root, appId, LINEAGE_FILENAME);
      if (!existsSync(lineagePath)) continue;
      const lineage = JSON.parse(readFileSync(lineagePath, "utf8"));
      if (lineage?.mode === "track") return appId;
    }
  } catch {
    return null;
  }
  return null;
}

async function jsonFetch(method, path, body = null) {
  const url = `${gateway}${path}`;
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
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

async function fetchLiveRevision(namespaceId, slug) {
  const url = `https://apps.papr.ai/${encodeURIComponent(namespaceId)}/${encodeURIComponent(slug)}/__papr__/app-revision.json`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    return typeof data?.revision === "string" ? data.revision : null;
  } catch {
    return null;
  }
}

function readLineage(appId) {
  const path = join(appsRoot(), appId, LINEAGE_FILENAME);
  return { path, data: JSON.parse(readFileSync(path, "utf8")) };
}

function writeLineage(appId, lineage) {
  const path = join(appsRoot(), appId, LINEAGE_FILENAME);
  writeFileSync(path, `${JSON.stringify(lineage, null, 2)}\n`, "utf8");
}

async function waitForRevisionCatchUp(appId, liveRevision, deadlineMs) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const { data: lineage } = readLineage(appId);
    if (lineage.upstreamRevision === liveRevision) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await jsonFetch("POST", "/api/cloud/track-sync/pull-on-publish");
  }
  return readLineage(appId).data.upstreamRevision === liveRevision;
}

async function main() {
  loadEnvLocal();

  console.log(`\n${BOLD}${CYAN}Track Pull-on-Publish E2E${RESET}`);
  console.log(`Gateway: ${gateway}`);
  console.log(`PAPR_HOME: ${paprHome()}`);
  console.log("=".repeat(60));

  const health = await jsonFetch("GET", "/health");
  check("gateway health", health.status === 200, health.text.slice(0, 120));

  const resolvedAppId = pickTrackAppIdFromDisk();

  check("found track-mode app", Boolean(resolvedAppId), "pass --app-id=...");
  if (!resolvedAppId) {
    console.log(`\n${RED}${failed} failed, ${passed} passed${RESET}`);
    process.exit(1);
  }

  const original = readLineage(resolvedAppId);
  const lineage = original.data;
  check("lineage mode is track", lineage.mode === "track", lineage.mode);
  check("trackAutoPull enabled", lineage.trackAutoPull !== false);

  const liveRevision = await fetchLiveRevision(
    lineage.source.namespaceId,
    lineage.source.slug,
  );
  check("live publisher revision available", Boolean(liveRevision), "apps.papr.ai unreachable?");

  if (!liveRevision) {
    console.log(`\n${RED}${failed} failed, ${passed} passed${RESET}`);
    process.exit(1);
  }

  const staleRevision =
    liveRevision === lineage.upstreamRevision
      ? `stale-${liveRevision.slice(0, 8)}-e2e`
      : (lineage.upstreamRevision ?? "stale-e2e-revision");

  console.log(`\n${BOLD}--- Stale upstream revision ---${RESET}`);
  console.log(`  App:              ${resolvedAppId}`);
  console.log(`  Live revision:    ${liveRevision.slice(0, 16)}…`);
  console.log(`  Stale revision:   ${staleRevision.slice(0, 16)}…`);

  writeLineage(resolvedAppId, {
    ...lineage,
    upstreamRevision: staleRevision,
  });

  console.log(`\n${BOLD}--- Pull on publish ---${RESET}`);
  const pull = await jsonFetch("POST", "/api/cloud/track-sync/pull-on-publish");
  check("pull-on-publish HTTP 200", pull.status === 200, pull.text.slice(0, 200));
  check("pull-on-publish returns results", Array.isArray(pull.data?.results), pull.text.slice(0, 200));

  const appResult = Array.isArray(pull.data?.results)
    ? pull.data.results.find((entry) => entry.appId === resolvedAppId)
    : null;
  check("result includes target app", Boolean(appResult), JSON.stringify(pull.data?.results ?? []));
  check(
    "target app synced or already current",
    appResult?.action === "synced" || appResult?.action === "skipped",
    appResult?.action ?? "missing",
  );

  console.log(`\n${BOLD}--- Convergence within ${pollSeconds}s ---${RESET}`);
  const caughtUp = await waitForRevisionCatchUp(
    resolvedAppId,
    liveRevision,
    pollSeconds * 1000,
  );
  check(
    "upstreamRevision matches live publisher revision",
    caughtUp,
    readLineage(resolvedAppId).data.upstreamRevision ?? "null",
  );

  if (!skipCleanup && original.data.upstreamRevision !== staleRevision) {
    writeLineage(resolvedAppId, original.data);
    console.log(`\n${YELLOW}Restored original upstreamRevision${RESET}`);
  }

  console.log("\n" + "=".repeat(60));
  if (failed === 0) {
    console.log(`${GREEN}${BOLD}All ${passed} checks passed${RESET}`);
    process.exit(0);
  }
  console.log(`${RED}${BOLD}${failed} failed, ${passed} passed${RESET}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`${RED}Fatal:${RESET}`, err);
  process.exit(1);
});
