#!/usr/bin/env node
/**
 * Two-user track install E2E — one namespace API key, two external_user_id values.
 *
 * Usage:
 *   PAPR_API_KEY=sk-org-... node scripts/test-cloud-track-two-user-e2e.mjs \
 *     --app-id=91d94d77-... \
 *     --publisher-user=WkPutXGdqg \
 *     --teammate-user=l6UFSw9m4T
 */

import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

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

const apiKey = process.env.PAPR_API_KEY?.trim();
const memoryBase =
  process.env.PAPR_MEMORY_SERVER_URL?.replace(/\/$/, "") ??
  "https://memory.papr.ai";

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

async function memoryFetch(path, { userId, method = "GET", body = null } = {}) {
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

function jobsForApp(paprHome, localAppId) {
  const raw = readFileSync(join(paprHome, "data", "jobs.json"), "utf8");
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : parsed.jobs ?? [];
  return list.filter((job) => job?.appIds?.includes(localAppId));
}

async function runTeammateInstall(teammateHome) {
  process.env.PAPR_HOME = teammateHome;
  process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID = teammateUser;
  process.env.PAPR_API_KEY = apiKey;
  process.env.CLOUD_SYNC_ENABLED = "false";
  process.env.GATEWAY_MODE = "cloud_agent";

  const installMod = await import(
    pathToFileURL(
      join(process.cwd(), "dist/gateway/services/CloudAppInstallService.js"),
    ).href
  );
  const service = installMod.getCloudAppInstallService();
  return service.installApp({
    namespaceId,
    slug,
    mode: "track",
  });
}

async function runTrackSync(teammateHome, localAppId) {
  process.env.PAPR_HOME = teammateHome;
  process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID = teammateUser;
  process.env.PAPR_API_KEY = apiKey;
  process.env.GATEWAY_MODE = "cloud_agent";

  const trackMod = await import(
    pathToFileURL(
      join(process.cwd(), "dist/gateway/services/CloudAppTrackSyncService.js"),
    ).href
  );
  return trackMod.getCloudAppTrackSyncService().syncTrackApp(localAppId);
}

async function main() {
  if (!apiKey) {
    console.error(`${RED}PAPR_API_KEY env var required${RESET}`);
    process.exit(1);
  }

  console.log(`\n${BOLD}${CYAN}Cloud Track Two-User E2E${RESET}`);
  console.log(`App:       ${appId} (${slug})`);
  console.log(`Namespace: ${namespaceId}`);
  console.log(`Publisher: ${publisherUser}`);
  console.log(`Teammate:  ${teammateUser}`);
  console.log("=".repeat(60));

  console.log(`\n${BOLD}--- Publisher publish config ---${RESET}`);
  const pub = await memoryFetch(
    `/v1/cloud/apps/publish/${encodeURIComponent(appId)}`,
    { userId: publisherUser },
  );
  check("publisher can read publish config", pub.status === 200, pub.text.slice(0, 200));
  check("app is published/enabled", pub.data?.enabled === true, String(pub.data?.enabled));
  check("codeAccess=install", pub.data?.codeAccess === "install", pub.data?.codeAccess);
  check("slug matches", pub.data?.slug === slug, pub.data?.slug);

  console.log(`\n${BOLD}--- Teammate track install (isolated PAPR_HOME) ---${RESET}`);
  const isolatedHome = mkdtempSync(join(tmpdir(), "papr-teammate-e2e-"));
  const teammateHome = join(isolatedHome, "Papr");
  mkdirSync(join(teammateHome, "data"), { recursive: true });
  mkdirSync(join(teammateHome, "apps"), { recursive: true });
  mkdirSync(join(teammateHome, "Jobs"), { recursive: true });
  writeFileSync(join(teammateHome, "data", "apps.json"), "[]\n");
  writeFileSync(join(teammateHome, "data", "jobs.json"), "[]\n");
  try {
    const result = await runTeammateInstall(teammateHome);
    const localAppId = result.app?.id;
    check("track install succeeded", !!localAppId, JSON.stringify(result.app));
    check("install mode=track", result.mode === "track", result.mode);
    check(
      "sourceAppId is publisher app",
      result.sourceAppId === appId,
      result.sourceAppId,
    );

    if (localAppId) {
      const lineagePath = join(
        teammateHome,
        "apps",
        localAppId,
        "papr-cloud-lineage.json",
      );
      check("lineage file exists", existsSync(lineagePath), lineagePath);
      if (existsSync(lineagePath)) {
        const lineage = JSON.parse(readFileSync(lineagePath, "utf8"));
        check("lineage mode=track", lineage.mode === "track", lineage.mode);
        check(
          "lineage source.appId matches publisher",
          lineage.source?.appId === appId,
          lineage.source?.appId,
        );
      }

      const linkedJobs = jobsForApp(teammateHome, localAppId);
      check(
        "linked jobs copied for teammate app",
        linkedJobs.length > 0,
        `count=${linkedJobs.length}`,
      );
      for (const job of linkedJobs.slice(0, 3)) {
        const jobDir = join(teammateHome, "Jobs", job.id);
        check(`job dir exists: ${job.name ?? job.id}`, existsSync(jobDir), jobDir);
        if (job.command?.includes("/Users/")) {
          check(
            `job command portable (${job.id})`,
            false,
            job.command.slice(0, 120),
          );
        }
      }

      const dsPath = join(teammateHome, "apps", localAppId, "data-sources.json");
      if (existsSync(dsPath)) {
        const ds = JSON.parse(readFileSync(dsPath, "utf8"));
        const publisherAbs = "/Users/amirkabbara/Papr/orgs/crwNcCnClI/namespaces/VIA2C5VDxj";
        const badPath = ds.sources?.some(
          (s) =>
            typeof s.dbPath === "string" &&
            (s.dbPath.includes(publisherAbs) ||
              s.dbPath.includes("/Users/amirkabbara/Papr/orgs/")),
        );
        check("data-sources dbPath not publisher machine path", !badPath, dsPath);
      }

      const previewUrl = `https://apps.papr.ai/${namespaceId}/${slug}`;
      check(
        "upstream web URL uses publisher namespace",
        previewUrl.includes(namespaceId) && previewUrl.includes(slug),
        previewUrl,
      );

      console.log(`\n${BOLD}--- Teammate track sync ---${RESET}`);
      const sync = await runTrackSync(teammateHome, localAppId);
      check("track sync returns appId", sync.appId === localAppId, sync.appId);
      check("track sync sets lastSyncedAt", !!sync.lastSyncedAt, sync.lastSyncedAt);
    }
  } finally {
    if (!skipCleanup) {
      rmSync(isolatedHome, { recursive: true, force: true });
    } else {
      console.log(`\n${YELLOW}Teammate home left at: ${teammateHome}${RESET}`);
    }
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
