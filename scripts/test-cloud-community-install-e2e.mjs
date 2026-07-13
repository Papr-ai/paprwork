#!/usr/bin/env node
/**
 * Cloud Community + Install E2E — publish → community catalog → fork install
 *
 * Prerequisites:
 *   1. Paprwork running: npm start  (gateway :18789)
 *   2. Logged in with Papr (PAPR_API_KEY in keychain)
 *   3. Memory server deployed with community/install routes
 *   4. App synced to papr-work git (Cloud Sync healthy for apps/{appId}/)
 *
 * Usage:
 *   npm run test:cloud-community-install
 *   node scripts/test-cloud-community-install-e2e.mjs [--gateway URL] [--app-id ID] [--no-cleanup]
 *
 * Default: picks first app from ~/Papr/data/apps.json, publishes public+install,
 * verifies community + install, then unpublishes (unless --no-cleanup).
 */

import { execSync } from "child_process";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const args = process.argv.slice(2);
const gateway = (
  args.find((a) => a.startsWith("--gateway="))?.split("=")[1] ??
  "http://localhost:18789"
).replace(/\/$/, "");
const appIdArg = args.find((a) => a.startsWith("--app-id="))?.split("=")[1];
const skipCleanup = args.includes("--no-cleanup");

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

function pickAppId() {
  if (appIdArg) return appIdArg;
  try {
    const raw = readFileSync(join(homedir(), "Papr", "data", "apps.json"), "utf8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : Object.values(parsed);
    const first = list.find((a) => a?.id);
    return first?.id ?? null;
  } catch {
    return null;
  }
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

async function main() {
  loadEnvLocal();
  const appId = pickAppId();
  if (!appId) {
    console.error(`${RED}No app ID — pass --app-id= or create a mini-app first${RESET}`);
    process.exit(1);
  }

  console.log(`\n${BOLD}${CYAN}Cloud Community + Install E2E${RESET}`);
  console.log(`Gateway: ${gateway}`);
  console.log(`App:     ${appId}`);
  console.log("=".repeat(60));

  console.log(`\n${BOLD}--- Gateway health ---${RESET}`);
  try {
    const health = await fetch(`${gateway}/health`);
    check("gateway /health → 200", health.status === 200, `status=${health.status}`);
  } catch (e) {
    check("gateway reachable", false, e.message);
    process.exit(1);
  }

  console.log(`\n${BOLD}--- Publish (public + code install) ---${RESET}`);
  const pub = await jsonFetch("POST", `/api/cloud/publish/${encodeURIComponent(appId)}`, {
    accessMode: "public_read",
    codeAccess: "install",
    autoPublish: true,
  });
  check("publish → 200", pub.status === 200, pub.text.slice(0, 200));
  if (pub.status !== 200) process.exit(1);

  const slug = pub.data.slug;
  const shareUrl = pub.data.shareUrl;
  check("publish returns slug", typeof slug === "string" && slug.length >= 2, slug);
  check("publish codeAccess=install in prefs", pub.data.prefs?.codeAccess === "install");
  check("publish shareUrl present", !!shareUrl, shareUrl ?? "missing");

  console.log(`\n${BOLD}--- Community catalog ---${RESET}`);
  const comm = await jsonFetch("GET", "/api/cloud/apps/community");
  check("community → 200", comm.status === 200, comm.text.slice(0, 200));
  const entry = comm.data.apps?.find(
    (a) => a.appId === appId && a.slug === slug,
  );
  check("community lists published app", !!entry, `apps=${comm.data.apps?.length ?? 0}`);
  check("community codeAccess=install", entry?.codeAccess === "install", entry?.codeAccess);
  const namespaceId = entry?.namespaceId;
  check("community has namespaceId", !!namespaceId, namespaceId ?? "missing");

  console.log(`\n${BOLD}--- Fork install ---${RESET}`);
  const inst = await jsonFetch("POST", "/api/cloud/install", {
    namespaceId,
    slug,
    mode: "fork",
  });
  check("install → 200", inst.status === 200, inst.text.slice(0, 300));
  if (inst.status === 200) {
    check("install returns new app id", !!inst.data.app?.id, JSON.stringify(inst.data.app));
    check("install returns lineageId", !!inst.data.lineageId, inst.data.lineageId);
    check("install mode=fork", inst.data.mode === "fork", inst.data.mode);
    check(
      "install sourceAppId matches publisher",
      inst.data.sourceAppId === appId,
      inst.data.sourceAppId,
    );

    const installedId = inst.data.app?.id;
    if (installedId) {
      const appDir = join(homedir(), "Papr", "apps", installedId);
      try {
        const listing = execSync(`ls -1 "${appDir}"`, { encoding: "utf8" });
        check("installed app dir has files", listing.trim().length > 0, appDir);
        check(
          "papr-cloud-lineage.json exists",
          listing.includes("papr-cloud-lineage.json"),
          listing,
        );
      } catch (e) {
        check("installed app dir exists", false, e.message);
      }
    }
  }

  if (!skipCleanup) {
    console.log(`\n${BOLD}--- Cleanup (unpublish) ---${RESET}`);
    const del = await jsonFetch(
      "DELETE",
      `/api/cloud/publish/${encodeURIComponent(appId)}`,
    );
    check("unpublish → 200", del.status === 200, del.text.slice(0, 120));
  } else {
    console.log(`\n${YELLOW}Skipping cleanup (--no-cleanup)${RESET}`);
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
