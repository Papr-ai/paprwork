#!/usr/bin/env node
/**
 * Contribute-back PR E2E — fork install → edit → propose → list incoming
 *
 * Prerequisites:
 *   1. Memory server running locally (or set PAPR_MEMORY_SERVER_URL)
 *      cd ../memory && uvicorn main:app --reload --port 8000
 *   2. Paprwork gateway: npm start  (or npm run build && node dist/gateway/index.js)
 *   3. PAPR_API_KEY in env or .env.local
 *   4. GITHUB_APP_* configured on memory for full PR flow (optional — partial pass without)
 *
 * Usage:
 *   npm run test:contribute-back-e2e
 *   node scripts/test-contribute-back-e2e.mjs [--gateway URL] [--memory URL] [--app-id ID] [--approve]
 */

import { execSync } from "child_process";
import { randomUUID } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir, userInfo } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

const args = process.argv.slice(2);
const gateway = (
  args.find((a) => a.startsWith("--gateway="))?.split("=")[1] ??
  "http://localhost:18789"
).replace(/\/$/, "");
const memoryBase = (
  args.find((a) => a.startsWith("--memory="))?.split("=")[1] ??
  process.env.PAPR_MEMORY_SERVER_URL ??
  "http://localhost:8000"
).replace(/\/$/, "");
const appIdArg = args.find((a) => a.startsWith("--app-id="))?.split("=")[1];
const slugArg = args.find((a) => a.startsWith("--slug="))?.split("=")[1];
const namespaceArg = args.find((a) => a.startsWith("--namespace-id="))?.split("=")[1];
const skipCleanup = args.includes("--no-cleanup");
const tryApprove = args.includes("--approve");
const forceDirect = args.includes("--direct");

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

function loadMemoryEnv() {
  const candidates = [
    join(process.cwd(), "../memory/.env"),
    join(getUserHomeDir(), "Documents/GitHub/memory/.env"),
  ];
  for (const envPath of candidates) {
    try {
      const raw = readFileSync(envPath, "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (!process.env[key] && (key.startsWith("GITHUB_") || key === "PAPR_MEMORY_SERVER_URL")) {
          process.env[key] = value;
        }
      }
      return;
    } catch {
      /* try next */
    }
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

function getUserHomeDir() {
  try {
    return userInfo().homedir;
  } catch {
    return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  }
}

function readActiveWorkspace() {
  try {
    const raw = readFileSync(join(getUserHomeDir(), "Papr", ".active-workspace.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function resolveGatewayPaprHome(activeWs, namespaceId) {
  if (activeWs?.paprHome && existsSync(activeWs.paprHome)) {
    return activeWs.paprHome;
  }
  const userHome = getUserHomeDir();
  if (activeWs?.organizationId && activeWs?.namespaceId) {
    const derived = join(
      userHome,
      "Papr",
      "orgs",
      activeWs.organizationId,
      "namespaces",
      activeWs.namespaceId,
    );
    if (existsSync(derived)) return derived;
  }
  if (namespaceId) {
    const orgsRoot = join(userHome, "Papr", "orgs");
    try {
      for (const orgId of readdirSync(orgsRoot, { withFileTypes: true })) {
        if (!orgId.isDirectory()) continue;
        const candidate = join(orgsRoot, orgId.name, "namespaces", namespaceId);
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      /* optional */
    }
  }
  return null;
}

function pickAppId(activeWs) {
  if (appIdArg) return appIdArg;
  const paprHome = activeWs?.paprHome ?? process.env.PAPR_HOME;
  const candidates = [paprHome, join(getUserHomeDir(), "Papr"), join(getUserHomeDir(), ".paprwork-v2")].filter(
    Boolean,
  );
  for (const root of candidates) {
    try {
      const raw = readFileSync(join(root, "data", "apps.json"), "utf8");
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : Object.values(parsed);
      const first = list.find((a) => a?.id);
      if (first?.id) return first.id;
    } catch {
      /* try next */
    }
  }
  return null;
}

function pickInstallEnabledAppId(paprHome) {
  if (!paprHome) return null;
  try {
    const prefs = JSON.parse(
      readFileSync(join(paprHome, "data", "cloud-publish-prefs.json"), "utf8"),
    );
    const apps = prefs?.apps ?? {};
    for (const [id, cfg] of Object.entries(apps)) {
      if (cfg?.codeAccess === "install") return id;
    }
  } catch {
    /* optional */
  }
  return null;
}

async function resolvePublishedAppViaGateway(appId) {
  const resp = await gatewayFetch(`/api/cloud/publish/${encodeURIComponent(appId)}`);
  if (resp.status !== 200 || typeof resp.data !== "object" || !resp.data || resp.data.error) {
    return null;
  }
  const slug = resp.data.slug?.trim();
  const shareUrl = resp.data.shareUrl ?? "";
  const nsFromUrl = shareUrl.match(/apps\.papr\.ai\/([^/]+)\//)?.[1];
  const codeAccess = resp.data.prefs?.codeAccess ?? resp.data.codeAccess;
  return {
    slug,
    namespaceId: nsFromUrl ?? null,
    codeAccess,
    title: resp.data.title ?? appId,
  };
}

function slugifyTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function resolveLocalAppContext(paprHome, appId) {
  if (!paprHome || !appId) return null;
  try {
    const appsRaw = readFileSync(join(paprHome, "data", "apps.json"), "utf8");
    const apps = Array.isArray(JSON.parse(appsRaw))
      ? JSON.parse(appsRaw)
      : Object.values(JSON.parse(appsRaw));
    const app = apps.find((entry) => entry?.id === appId);
    let codeAccess;
    try {
      const prefs = JSON.parse(
        readFileSync(join(paprHome, "data", "cloud-publish-prefs.json"), "utf8"),
      );
      codeAccess = prefs?.apps?.[appId]?.codeAccess;
    } catch {
      /* optional */
    }
    const nsFromPath = paprHome.match(/namespaces\/([^/]+)/)?.[1] ?? null;
    return {
      slug: slugifyTitle(app?.title ?? appId.slice(0, 8)),
      namespaceId: nsFromPath,
      codeAccess,
      title: app?.title ?? appId,
    };
  } catch {
    return null;
  }
}

function removeForkApp(paprHome, forkAppId) {
  if (!paprHome || !forkAppId) return;
  try {
    rmSync(join(paprHome, "apps", forkAppId), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  try {
    const appsPath = join(paprHome, "data", "apps.json");
    const raw = readFileSync(appsPath, "utf8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : Object.values(parsed);
    const next = list.filter((a) => a?.id !== forkAppId);
    writeFileSync(appsPath, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    /* ignore */
  }
}

/** Self-contained owner workspace when no local mini-app exists. */
function bootstrapOwnerHome() {
  const appId = randomUUID();
  const ownerHome = join(tmpdir(), `papr-contrib-owner-${Date.now()}`);
  const appDir = join(ownerHome, "apps", appId);
  mkdirSync(join(ownerHome, "data"), { recursive: true });
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    join(appDir, "metadata.json"),
    `${JSON.stringify(
      {
        title: "E2E Contribute App",
        description: "Minimal app for contribute-back testing",
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(appDir, "index.html"),
    `<!DOCTYPE html><html><body><h1>E2E Contribute</h1></body></html>\n`,
  );
  writeFileSync(
    join(ownerHome, "data", "apps.json"),
    `${JSON.stringify(
      [
        {
          id: appId,
          title: "E2E Contribute App",
          description: "Minimal app for contribute-back testing",
          type: "mini-app",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(ownerHome, "data", "jobs.json"), "[]\n");
  return { ownerHome, appId };
}

async function gatewayFetch(path, { method = "GET", body = null } = {}) {
  const url = `${gateway}${path}`;
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body && method !== "GET") {
    opts.body = JSON.stringify(body);
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

function applyApiKeyWorkspaceScope() {
  const apiKey = process.env.PAPR_API_KEY?.trim();
  if (!apiKey) return;
  const match = apiKey.match(/^sk-org-([^-]+)-namespace-([^-]+)/);
  if (!match) return;
  process.env.PAPR_ORG_ID = match[1];
  process.env.PAPR_NAMESPACE_ID = match[2];
}

function namespaceFromApiKey(apiKey) {
  const match = apiKey?.match(/namespace-([A-Za-z0-9]+)/);
  return match?.[1] ?? null;
}

async function memoryFetch(path, { method = "GET", body = null } = {}) {
  const apiKey = process.env.PAPR_API_KEY?.trim();
  if (!apiKey) throw new Error("PAPR_API_KEY required");
  const url = `${memoryBase}${path}`;
  const opts = {
    method,
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
    },
  };
  if (body && method !== "GET") {
    opts.body = JSON.stringify(body);
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

async function main() {
  loadEnvLocal();
  loadMemoryEnv();
  applyApiKeyWorkspaceScope();
  process.env.PAPR_MEMORY_SERVER_URL = memoryBase;
  process.env.GATEWAY_MODE = process.env.GATEWAY_MODE ?? "cloud_agent";

  console.log(`\n${BOLD}${CYAN}Contribute-back PR E2E${RESET}`);
  console.log(`  Gateway: ${gateway}`);
  console.log(`  Memory:  ${memoryBase}\n`);

  if (!process.env.PAPR_API_KEY?.trim()) {
    console.log(`${RED}PAPR_API_KEY not set — login with Papr first${RESET}`);
    process.exit(1);
  }

  // Health
  try {
    const g = await fetch(`${gateway}/api/sync/status`);
    check("gateway reachable", g.ok, `status ${g.status}`);
  } catch (err) {
    check("gateway reachable", false, (err).message);
    process.exit(1);
  }

  try {
    const m = await memoryFetch("/health");
    check("memory reachable", m.status === 200, `status ${m.status}`);
  } catch (err) {
    check("memory reachable", false, (err).message);
    process.exit(1);
  }

  const legacy = await memoryFetch("/v1/cloud/apps/changes", {
    method: "POST",
    body: {
      sourceNamespaceId: "test",
      sourceSlug: "test",
      installedAppId: "00000000-0000-4000-8000-000000000001",
      title: "x",
      description: "y",
    },
  });
  check("legacy metadata-only route removed", legacy.status === 404, legacy.text.slice(0, 80));

  const activeWs = readActiveWorkspace();
  let appId = pickAppId(activeWs);
  if (!appIdArg && activeWs?.paprHome) {
    const installApp = pickInstallEnabledAppId(activeWs.paprHome);
    if (installApp) {
      appId = installApp;
      console.log(`  ${YELLOW}Auto-picked${RESET} install-enabled app: ${appId}`);
    }
  }

  let ownerHomeBootstrapped = null;
  const gatewayPaprHomeEarly = resolveGatewayPaprHome(activeWs, activeWs?.namespaceId ?? namespaceArg);
  let useGatewayFlow = !forceDirect && !!gatewayPaprHomeEarly;
  let published = null;
  if (appId && useGatewayFlow) {
    published = await resolvePublishedAppViaGateway(appId);
  }

  if (!appId) {
    const boot = bootstrapOwnerHome();
    ownerHomeBootstrapped = boot.ownerHome;
    appId = boot.appId;
    process.env.PAPR_HOME = ownerHomeBootstrapped;
    useGatewayFlow = false;
    console.log(`  ${YELLOW}Bootstrap${RESET} owner home: ${ownerHomeBootstrapped}`);
    console.log(`  ${YELLOW}Bootstrap${RESET} app id: ${appId}`);
  }
  check("app id resolved", !!appId, appId ?? "missing");
  if (!appId) process.exit(1);

  let slug;
  let namespaceId = namespaceArg ?? activeWs?.namespaceId ?? null;
  const gatewayPaprHome = resolveGatewayPaprHome(activeWs, namespaceId);
  const localContext = resolveLocalAppContext(gatewayPaprHome, appId);

  if (slugArg) {
    slug = slugArg;
    check("use explicit slug", true, slug);
  } else if (published?.slug && published.codeAccess === "install") {
    slug = published.slug;
    namespaceId = namespaceId ?? published.namespaceId;
    check("use existing published app", true, `${slug} (${appId})`);
  } else if (localContext?.slug && localContext.codeAccess === "install") {
    slug = localContext.slug;
    namespaceId = namespaceId ?? localContext.namespaceId;
    check("use local published app", true, `${slug} (${appId})`);
  } else if (useGatewayFlow && gatewayPaprHome) {
    slug = published?.slug ?? localContext?.slug ?? slugifyTitle(appId.slice(0, 8));
    namespaceId = namespaceId ?? published?.namespaceId ?? localContext?.namespaceId;
    check("use gateway flow slug", !!slug, `${slug} (${appId})`);
  } else {
    slug = `e2e-contrib-${Date.now().toString(36)}`;
    const pub = await memoryFetch("/v1/cloud/apps/publish", {
      method: "POST",
      body: {
        appId,
        slug,
        visibility: "public_read",
        linkPermission: "read",
        codeAccess: "install",
      },
    });
    check("publish app for install", pub.status === 200, pub.text?.slice?.(0, 120) ?? String(pub.status));
    namespaceId =
      pub.data?.namespaceId ??
      pub.data?.namespace_id ??
      pub.data?.config?.namespaceId ??
      namespaceId;
  }

  if (!namespaceId) {
    const cfg = await memoryFetch(`/v1/cloud/apps/publish/${appId}`);
    namespaceId =
      cfg.data?.namespaceId ?? cfg.data?.namespace_id ?? cfg.data?.config?.namespaceId;
  }
  if (!namespaceId) {
    namespaceId = namespaceFromApiKey(process.env.PAPR_API_KEY?.trim());
  }
  check("namespace id resolved", !!namespaceId, String(namespaceId ?? "missing"));

  const contribHome = join(tmpdir(), `papr-contrib-e2e-${Date.now()}`);
  let forkAppId;
  let sourceAppId;

  try {
    if (useGatewayFlow && gatewayPaprHome) {
      console.log(`  ${CYAN}Gateway flow${RESET} (keychain auth, paprHome=${gatewayPaprHome})`);
      const install = await gatewayFetch("/api/cloud/install", {
        method: "POST",
        body: { namespaceId, slug, mode: "fork" },
      });
      check("fork install via gateway", install.status === 200, install.data?.error ?? install.text?.slice?.(0, 120));
      forkAppId = install.data?.app?.id;
      sourceAppId = install.data?.sourceAppId ?? appId;
      check("lineage file exists", existsSync(join(gatewayPaprHome, "apps", forkAppId ?? "", "papr-cloud-lineage.json")));

      const metaPath = join(gatewayPaprHome, "apps", forkAppId, "metadata.json");
      let meta = {};
      try {
        meta = JSON.parse(readFileSync(metaPath, "utf8"));
      } catch {
        meta = { title: "E2E Fork", description: "Original" };
      }
      meta.description = `Contribute E2E edit ${new Date().toISOString()}`;
      writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

      const hasGithub = !!(process.env.GITHUB_APP_ID && process.env.GITHUB_ORG);
      if (!hasGithub) {
        console.log(`  ${YELLOW}SKIP${RESET} full PR flow (set GITHUB_APP_ID/GITHUB_ORG in env to verify)`);
        check("fork ready for contribute", !!forkAppId);
      } else {
        const propose = await gatewayFetch("/api/cloud/apps/changes", {
          method: "POST",
          body: {
            sourceNamespaceId: namespaceId,
            sourceSlug: slug,
            installedAppId: forkAppId,
            title: "E2E contribute proposal",
            description: "Automated test edit to metadata.json description",
          },
        });
        check("propose via gateway", propose.status === 200, propose.data?.error ?? propose.text?.slice?.(0, 120));
        const proposeResult = propose.data;
        check("propose has request id", !!proposeResult?.id, JSON.stringify(proposeResult ?? {}));
        check("propose has prUrl", !!proposeResult?.prUrl, proposeResult?.prUrl ?? "missing");
        check(
          "propose staged app path",
          (proposeResult?.stagedPaths ?? []).some((p) => p.startsWith("apps/")),
        );

        const incoming = await gatewayFetch("/api/cloud/apps/changes/incoming");
        check("incoming list 200", incoming.status === 200);
        const match = (incoming.data?.requests ?? []).find((r) => r.id === proposeResult?.id);
        check("incoming lists proposal", !!match);
        check("incoming has prUrl", !!match?.prUrl);

        if (tryApprove && match?.id) {
          if (typeof match.prNumber === "number") {
            const approved = await gatewayFetch(
              `/api/cloud/apps/changes/${encodeURIComponent(match.id)}/approve`,
              { method: "POST" },
            );
            check("approve returns 200", approved.status === 200, approved.data?.error ?? approved.data?.detail ?? "");
            check(
              "approve status approved",
              approved.data?.status === "approved" || approved.data?.pull?.pulled === true,
            );
          } else {
            console.log(
              `  ${YELLOW}SKIP${RESET} approve (GitHub App needs Pull requests permission — got compare URL only)`,
            );
            check("approve skipped (no prNumber)", true, match.prUrl ?? "");
          }
        }
      }
    } else {
      mkdirSync(join(contribHome, "data"), { recursive: true });
      mkdirSync(join(contribHome, "apps"), { recursive: true });
      writeFileSync(join(contribHome, "data", "apps.json"), "[]\n");
      writeFileSync(join(contribHome, "data", "jobs.json"), "[]\n");

      process.env.PAPR_HOME = contribHome;
      process.env.CLOUD_SYNC_ENABLED = "false";
      process.env.TURSO_SYNC_ENABLED = "false";

      const contribSvcPath = join(
        process.cwd(),
        "dist/gateway/services/CloudAppContributeService.js",
      );
      if (!existsSync(contribSvcPath)) {
        execSync("npm run build:gateway", { stdio: "pipe", cwd: process.cwd() });
      }
      const installMod = await import(
        pathToFileURL(
          join(process.cwd(), "dist/gateway/services/CloudAppInstallService.js"),
        ).href
      );
      const install = await installMod.getCloudAppInstallService().installApp({
        namespaceId,
        slug,
        mode: "fork",
      });
      forkAppId = install.app.id;
      sourceAppId = install.sourceAppId;
      check("fork install", !!forkAppId, forkAppId ?? "");
      check("lineage file exists", existsSync(join(contribHome, "apps", forkAppId, "papr-cloud-lineage.json")));

      const metaPath = join(contribHome, "apps", forkAppId, "metadata.json");
      let meta = {};
      try {
        meta = JSON.parse(readFileSync(metaPath, "utf8"));
      } catch {
        meta = { title: "E2E Fork", description: "Original" };
      }
      meta.description = `Contribute E2E edit ${new Date().toISOString()}`;
      writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

      const proposeMod = await import(
        pathToFileURL(
          join(process.cwd(), "dist/gateway/services/CloudAppContributeService.js"),
        ).href
      );
      const hasGithub = !!(process.env.GITHUB_APP_ID && process.env.GITHUB_ORG);
      if (!hasGithub) {
        console.log(`  ${YELLOW}SKIP${RESET} full PR flow (GITHUB_APP_* not set on memory)`);
        check("fork ready for contribute", !!forkAppId);
      } else {
        try {
          const proposeResult = await proposeMod.getCloudAppContributeService().propose({
            sourceNamespaceId: namespaceId,
            sourceSlug: slug,
            installedAppId: forkAppId,
            title: "E2E contribute proposal",
            description: "Automated test edit to metadata.json description",
          });

          check("propose has request id", !!proposeResult?.id, JSON.stringify(proposeResult ?? {}));
          check("propose has prUrl", !!proposeResult?.prUrl, proposeResult?.prUrl ?? "missing");
          check(
            "propose staged app path",
            (proposeResult?.stagedPaths ?? []).some((p) => p.startsWith("apps/")),
          );

          const incoming = await memoryFetch("/v1/cloud/apps/changes/incoming");
          check("incoming list 200", incoming.status === 200);
          const match = (incoming.data?.requests ?? []).find(
            (r) => r.id === proposeResult?.id,
          );
          check("incoming lists proposal", !!match);
          check("incoming has prUrl", !!match?.prUrl);

          if (tryApprove && match?.id) {
            const approved = await memoryFetch(
              `/v1/cloud/apps/changes/${match.id}/approve`,
              { method: "POST" },
            );
            check("approve returns 200", approved.status === 200, approved.data?.detail ?? "");
            check("approve status approved", approved.data?.status === "approved");
          }
        } catch (proposeErr) {
          const msg = proposeErr instanceof Error ? proposeErr.message : String(proposeErr);
          check("propose succeeded", false, msg.slice(0, 120));
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check("contribute e2e setup", false, msg.slice(0, 160));
  } finally {
    if (!skipCleanup) {
      if (ownerHomeBootstrapped) {
        try {
          await memoryFetch(`/v1/cloud/apps/publish/${appId}`, { method: "DELETE" });
        } catch {
          /* ignore */
        }
        rmSync(ownerHomeBootstrapped, { recursive: true, force: true });
      }
      if (useGatewayFlow && gatewayPaprHome && forkAppId) {
        removeForkApp(gatewayPaprHome, forkAppId);
      } else if (existsSync(contribHome)) {
        rmSync(contribHome, { recursive: true, force: true });
      }
    } else {
      if (existsSync(contribHome)) {
        console.log(`  ${YELLOW}Kept contrib home:${RESET} ${contribHome}`);
      }
      if (ownerHomeBootstrapped) {
        console.log(`  ${YELLOW}Kept owner home:${RESET} ${ownerHomeBootstrapped}`);
      }
      if (useGatewayFlow && gatewayPaprHome && forkAppId) {
        console.log(`  ${YELLOW}Kept fork app:${RESET} ${forkAppId}`);
      }
    }
  }

  console.log(`\n${BOLD}Results:${RESET} ${GREEN}${passed} passed${RESET}, ${failed > 0 ? RED : ""}${failed} failed${RESET}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
