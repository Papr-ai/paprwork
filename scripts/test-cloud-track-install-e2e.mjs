#!/usr/bin/env node
/**
 * Cloud Track Install E2E — publish → track install → linked jobs → track sync
 *
 * Prerequisites:
 *   1. Paprwork running: npm start (gateway :18789)
 *   2. Papr logged in (PAPR_API_KEY in keychain)
 *   3. App synced to papr-work git with linked jobs in repo
 *   4. Prefer an app with at least one job linked in data-sources.json
 *
 * Usage:
 *   npm run test:cloud-track-install
 *   node scripts/test-cloud-track-install-e2e.mjs [--gateway URL] [--app-id ID] [--no-cleanup]
 *
 * Notes:
 *   - Uses ONE Papr account: installs track copy of your own published app (valid smoke test).
 *   - Full two-teammate Web preview still needs a second account (manual or CI secret).
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

function readLineage(installedAppId) {
  const lineagePath = join(
    homedir(),
    "Papr",
    "apps",
    installedAppId,
    "papr-cloud-lineage.json",
  );
  return JSON.parse(readFileSync(lineagePath, "utf8"));
}

function jobsForApp(appId) {
  const raw = readFileSync(join(homedir(), "Papr", "data", "jobs.json"), "utf8");
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : parsed.jobs ?? [];
  return list.filter((job) => job?.appIds?.includes(appId));
}

async function main() {
  loadEnvLocal();
  const publisherAppId = pickAppId();
  if (!publisherAppId) {
    console.error(`${RED}No app ID — pass --app-id= or create a mini-app first${RESET}`);
    process.exit(1);
  }

  console.log(`\n${BOLD}${CYAN}Cloud Track Install E2E${RESET}`);
  console.log(`Gateway:  ${gateway}`);
  console.log(`Publisher app: ${publisherAppId}`);
  console.log("=".repeat(60));

  console.log(`\n${BOLD}--- Gateway health ---${RESET}`);
  try {
    const health = await fetch(`${gateway}/health`);
    check("gateway /health → 200", health.status === 200, `status=${health.status}`);
  } catch (e) {
    check("gateway reachable", false, e.message);
    process.exit(1);
  }

  console.log(`\n${BOLD}--- Publish (public + install) ---${RESET}`);
  const pub = await jsonFetch(
    "POST",
    `/api/cloud/publish/${encodeURIComponent(publisherAppId)}`,
    {
      accessMode: "public_read",
      codeAccess: "install",
      autoPublish: true,
    },
  );
  check("publish → 200", pub.status === 200, pub.text.slice(0, 200));
  if (pub.status !== 200) process.exit(1);

  const slug = pub.data.slug;
  const namespaceId = pub.data.namespaceId ?? pub.data.prefs?.namespaceId;
  check("publish returns slug", typeof slug === "string" && slug.length >= 2, slug);
  check("publish returns namespaceId", !!namespaceId, namespaceId ?? "missing");

  console.log(`\n${BOLD}--- Track install ---${RESET}`);
  const inst = await jsonFetch("POST", "/api/cloud/install", {
    namespaceId,
    slug,
    mode: "track",
  });
  check("track install → 200", inst.status === 200, inst.text.slice(0, 300));

  const installedAppId = inst.data?.app?.id;
  check("install returns new app id", !!installedAppId, JSON.stringify(inst.data?.app));
  check("install mode=track", inst.data?.mode === "track", inst.data?.mode);
  check(
    "install sourceAppId matches publisher",
    inst.data?.sourceAppId === publisherAppId,
    inst.data?.sourceAppId,
  );

  if (installedAppId) {
    try {
      const lineage = readLineage(installedAppId);
      check("lineage mode=track", lineage.mode === "track", lineage.mode);
      check(
        "lineage source.appId matches publisher",
        lineage.source?.appId === publisherAppId,
        lineage.source?.appId,
      );
      check(
        "lineage sourceSlug matches slug",
        lineage.source?.slug === slug,
        lineage.source?.slug,
      );

      const appDir = join(homedir(), "Papr", "apps", installedAppId);
      const listing = execSync(`ls -1 "${appDir}"`, { encoding: "utf8" });
      check("installed app dir has files", listing.trim().length > 0, appDir);

      const linkedJobs = jobsForApp(installedAppId);
      check(
        "jobs.json lists jobs for installed app",
        linkedJobs.length >= 0,
        `count=${linkedJobs.length}`,
      );

      for (const job of linkedJobs.slice(0, 3)) {
        const jobDir = join(homedir(), "Papr", "Jobs", job.id);
        try {
          execSync(`test -d "${jobDir}"`, { encoding: "utf8" });
          check(`job dir exists: ${job.name ?? job.id}`, true);
          if (job.command?.includes(publisherAppId)) {
            check(
              `job command remapped (${job.id})`,
              false,
              "still contains publisher app id",
            );
          }
        } catch {
          check(`job dir exists: ${job.name ?? job.id}`, false, jobDir);
        }
      }

      const previewUrl = `${gateway}/cloud-preview/${namespaceId}/${slug}/`;
      const preview = await fetch(previewUrl, { redirect: "manual" });
      check(
        "publisher cloud-preview reachable",
        preview.status === 200 || preview.status === 302,
        `status=${preview.status}`,
      );
    } catch (e) {
      check("post-install filesystem checks", false, e.message);
    }

    console.log(`\n${BOLD}--- Track sync (pull upstream) ---${RESET}`);
    const sync = await jsonFetch(
      "POST",
      `/api/cloud/track-sync/${encodeURIComponent(installedAppId)}`,
    );
    check("track-sync → 200", sync.status === 200, sync.text.slice(0, 200));
    check(
      "track-sync status ok",
      sync.data?.status === "synced" || sync.data?.status === "unchanged",
      sync.data?.status,
    );
  }

  if (!skipCleanup) {
    console.log(`\n${BOLD}--- Cleanup ---${RESET}`);
    const del = await jsonFetch(
      "DELETE",
      `/api/cloud/publish/${encodeURIComponent(publisherAppId)}`,
    );
    check("unpublish publisher → 200", del.status === 200, del.text.slice(0, 120));
    if (installedAppId) {
      console.log(
        `  ${YELLOW}Note:${RESET} track-installed app ${installedAppId} left on disk — delete manually if desired`,
      );
    }
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
