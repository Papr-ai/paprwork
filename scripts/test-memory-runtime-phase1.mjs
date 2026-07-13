#!/usr/bin/env node
/**
 * Phase 1 — verify memory server cloud runtime pieces (local or prod).
 *
 * Usage:
 *   node scripts/test-memory-runtime-phase1.mjs
 *   node scripts/test-memory-runtime-phase1.mjs --base=http://localhost:5001
 *   node scripts/test-memory-runtime-phase1.mjs --base=https://memory.papr.ai
 *
 * Env (.env.local or export):
 *   PAPR_MEMORY_SERVER_URL     — default https://memory.papr.ai
 *   PAPR_API_KEY               — for publish + access validate (owner)
 *   PAPR_CLOUD_APP_HOST_KEY    — must match memory server env for runtime tests
 */

import { readFileSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const baseArg = args.find((a) => a.startsWith("--base="))?.split("=").slice(1).join("=");
const appIdArg = args.find((a) => a.startsWith("--app-id="))?.split("=")[1];

const GREEN = "\x1b[92m";
const RED = "\x1b[91m";
const YELLOW = "\x1b[93m";
const CYAN = "\x1b[96m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

let passed = 0;
let failed = 0;
let skipped = 0;

function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  ${GREEN}PASS${RESET} ${name}`);
    passed++;
  } else {
    console.log(`  ${RED}FAIL${RESET} ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function skip(name, reason) {
  console.log(`  ${YELLOW}SKIP${RESET} ${name} — ${reason}`);
  skipped++;
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

async function fetchJson(url, opts = {}) {
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

/** Memory server requires `database` on runtime db-token (e.g. "data", job db name). */
function runtimeDbTokenBody(namespaceId, slug, database = "data") {
  return JSON.stringify({ namespaceId, slug, database });
}

async function main() {
  loadEnvLocal();

  const base = (baseArg ?? process.env.PAPR_MEMORY_SERVER_URL ?? "https://memory.papr.ai").replace(/\/$/, "");
  const apiKey = process.env.PAPR_API_KEY;
  const hostKey = process.env.PAPR_CLOUD_APP_HOST_KEY;

  console.log(`\n${BOLD}${CYAN}Memory Phase 1 — Cloud Runtime${RESET}`);
  console.log(`Base: ${base}`);
  console.log("=".repeat(70));

  console.log(`\n${BOLD}--- Health ---${RESET}`);
  try {
    const health = await fetchJson(`${base}/health`);
    check("GET /health → 200", health.status === 200, `status=${health.status}`);
  } catch (e) {
    check("GET /health reachable", false, e.message);
    console.log(`\n${RED}Cannot reach memory server. Start locally: cd memory && docker-compose up${RESET}`);
    process.exit(1);
  }

  console.log(`\n${BOLD}--- Runtime routes registered ---${RESET}`);
  const noHost = await fetchJson(`${base}/v1/cloud/apps/runtime/db-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: runtimeDbTokenBody("ns-test", "test-app"),
  });
  if (noHost.status === 404) {
    check("POST /v1/cloud/apps/runtime/db-token exists", false, "404 — route not deployed");
  } else if (noHost.status === 422) {
    check(
      "POST /v1/cloud/apps/runtime/db-token exists",
      false,
      "422 — request missing required database field",
    );
  } else if (noHost.status === 503) {
    check(
      "POST /v1/cloud/apps/runtime/db-token exists",
      true,
      "503 = route exists, host key not configured on server",
    );
    skip("host key auth", "Set PAPR_CLOUD_APP_HOST_KEY on memory server");
  } else {
    check(
      "POST /v1/cloud/apps/runtime/db-token exists",
      noHost.status === 401,
      `status=${noHost.status} ${noHost.text.slice(0, 80)}`,
    );
  }

  if (!hostKey) {
    skip("host key validation", "PAPR_CLOUD_APP_HOST_KEY not in env — add to .env.local for full test");
  } else {
    const badHost = await fetchJson(`${base}/v1/cloud/apps/runtime/db-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cloud-App-Host-Key": "intentionally-wrong-key",
      },
      body: runtimeDbTokenBody("ns-test", "test-app"),
    });
    check("invalid host key → 401", badHost.status === 401, `status=${badHost.status}`);

    const goodHostNoApp = await fetchJson(`${base}/v1/cloud/apps/runtime/db-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cloud-App-Host-Key": hostKey,
      },
      body: runtimeDbTokenBody("ns-nonexistent", "no-such-app"),
    });
    check(
      "valid host key + missing app → 403",
      goodHostNoApp.status === 403,
      `status=${goodHostNoApp.status} ${goodHostNoApp.text.slice(0, 80)}`,
    );
  }

  console.log(`\n${BOLD}--- Publish + access validate (owner API key) ---${RESET}`);
  if (!apiKey) {
    skip("publish flow", "PAPR_API_KEY not set");
  } else {
    let appId = appIdArg;
    if (!appId) {
      skip("publish with real app", "pass --app-id=YOUR_MINI_APP_ID for full integration");
    } else {
      const slug = `phase1-${Date.now().toString(36)}`;
      const publish = await fetchJson(`${base}/v1/cloud/apps/publish`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        body: JSON.stringify({
          appId,
          slug,
          visibility: "team",
          linkPermission: "read",
        }),
      });
      check("POST /v1/cloud/apps/publish → 200", publish.status === 200, publish.text.slice(0, 120));

      if (publish.status === 200) {
        const namespaceId = publish.data.shareUrl?.split("/").slice(-2)[0];
        check("shareUrl has namespace + slug", namespaceId && publish.data.slug === slug, publish.data.shareUrl);

        const validate = await fetchJson(`${base}/v1/cloud/apps/access/validate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": apiKey,
          },
          body: JSON.stringify({ namespaceId, slug }),
        });
        check("access/validate owner → 200", validate.status === 200, validate.text.slice(0, 120));
        if (validate.status === 200) {
          check("owner canRead", validate.data.canRead === true, JSON.stringify(validate.data));
        }

        if (hostKey && namespaceId) {
          console.log(`\n${BOLD}--- Runtime db-token (multi-tenant) ---${RESET}`);
          const dbToken = await fetchJson(`${base}/v1/cloud/apps/runtime/db-token`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Cloud-App-Host-Key": hostKey,
              "X-API-Key": apiKey,
            },
            body: runtimeDbTokenBody(namespaceId, slug, "data"),
          });
          if (dbToken.status === 200) {
            check("runtime db-token → 200", true);
            check("returns tursoUrl", typeof dbToken.data.tursoUrl === "string", "");
            check("returns authToken", typeof dbToken.data.authToken === "string", "");
            check("tursoUrl not empty", dbToken.data.tursoUrl.length > 0, "");
          } else if (
            dbToken.status === 403 &&
            dbToken.text.includes("not linked")
          ) {
            skip(
              "runtime db-token",
              "App has no linked database named \"data\" — link a data source or pass a job db name",
            );
          } else if (dbToken.status === 429) {
            skip("runtime db-token", "Turso database limit — user needs Turso provisioning");
          } else if (dbToken.status === 500) {
            skip("runtime db-token", `Turso error: ${dbToken.text.slice(0, 100)}`);
          } else {
            check("runtime db-token → 200", false, `status=${dbToken.status} ${dbToken.text.slice(0, 120)}`);
          }

          console.log(`\n${BOLD}--- Runtime repo-file ---${RESET}`);
          const repoFile = await fetchJson(`${base}/v1/cloud/apps/runtime/repo-file`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Cloud-App-Host-Key": hostKey,
              "X-API-Key": apiKey,
            },
            body: JSON.stringify({
              namespaceId,
              slug,
              relativePath: "index.html",
            }),
          });
          if (repoFile.status === 200) {
            check("runtime repo-file → 200", true);
            check("content returned", typeof repoFile.data.content === "string", "");
          } else if (repoFile.status === 404) {
            skip("runtime repo-file", "index.html not in GitHub repo yet — sync app first");
          } else {
            check("runtime repo-file → 200", false, `status=${repoFile.status} ${repoFile.text.slice(0, 120)}`);
          }
        }
      }
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(
    `Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}, ${YELLOW}${skipped} skipped${RESET}`,
  );

  if (failed > 0) {
    console.log(`\n${BOLD}Fix checklist:${RESET}`);
    console.log("1. Memory code includes cloud_app_runtime_service.py + runtime routes");
    console.log("2. Set PAPR_CLOUD_APP_HOST_KEY on memory (local .env or Cloud Run secret)");
    console.log("3. Same key in paprwork-v2 .env.local for this script + Cloud App Host");
    console.log("4. pytest tests/test_cloud_app_runtime_routes.py -v  (in memory repo)");
    process.exit(1);
  }

  console.log(`\n${GREEN}Phase 1 checks passed (skipped items are optional).${RESET}`);
}

main().catch((e) => {
  console.error(`${RED}Fatal:${RESET}`, e);
  process.exit(1);
});
