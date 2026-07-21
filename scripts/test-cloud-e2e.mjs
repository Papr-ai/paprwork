#!/usr/bin/env node
/**
 * Cloud E2E Test — Full stack: Paprwork Gateway → Memory Server → GCP/GitHub
 *
 * Calls Paprwork's /api/cloud/* proxy which attaches the user's real
 * PAPR_API_KEY from the system keychain, then forwards to the memory server.
 *
 * Prerequisites:
 *   1. Paprwork running: npm start  (gateway on port 18789)
 *   2. Memory server running: cd memory && python3 main.py  (port 5001)
 *   3. Set PAPR_MEMORY_SERVER_URL=http://localhost:5001 in .env.local
 *   4. PAPR_EDITION=cloud in memory/.env
 *
 * Usage:
 *   node scripts/test-cloud-e2e.mjs [--gateway URL]
 *
 * Default gateway: http://localhost:18789
 */

const args = process.argv.slice(2);
const gateway = (args.find((a) => a.startsWith("--gateway="))?.split("=")[1] ?? "http://localhost:18789").replace(/\/$/, "");

const GREEN = "\x1b[92m";
const RED = "\x1b[91m";
const YELLOW = "\x1b[93m";
const CYAN = "\x1b[96m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

let passed = 0;
let failed = 0;
let skipped = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ${GREEN}PASS${RESET} ${name}`);
    passed++;
  } else {
    console.log(`  ${RED}FAIL${RESET} ${name} — ${detail}`);
    failed++;
  }
}

function skip(name, reason) {
  console.log(`  ${YELLOW}SKIP${RESET} ${name} — ${reason}`);
  skipped++;
}

async function request(method, path, body = null) {
  const url = `${gateway}/api/cloud${path}`;
  const headers = { "Content-Type": "application/json" };

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(url, opts);
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: resp.status, data, text };
}

// ─── Tests ───────────────────────────────────────────────────────────

async function testGatewayHealth() {
  console.log(`\n${BOLD}--- Gateway Health Check ---${RESET}`);
  try {
    const resp = await fetch(`${gateway}/health`);
    check("Paprwork gateway reachable", resp.status === 200, `status=${resp.status}`);
  } catch (e) {
    check("Paprwork gateway reachable", false, `${e.message} — Is Paprwork running? (npm start)`);
    console.log(`\n${RED}Gateway not reachable at ${gateway}${RESET}`);
    console.log("Start Paprwork: npm start");
    process.exit(1);
  }
}

async function testProxyAuth() {
  console.log(`\n${BOLD}--- Proxy Auth (PAPR_API_KEY from keychain) ---${RESET}`);
  const r = await request("GET", "/vault/keys?scope=user");
  if (r.status === 401 && r.text.includes("PAPR_API_KEY not configured")) {
    check("Proxy has PAPR_API_KEY", false, "Login with Papr first (Settings → AI Models → Login with Papr)");
    return false;
  }
  if (r.status === 502) {
    check("Memory server reachable via proxy", false,
      `502 Bad Gateway — Is memory server running? Set PAPR_MEMORY_SERVER_URL=http://localhost:5001 in .env.local`);
    return false;
  }
  check("Proxy authenticates with keychain key", r.status !== 401, `status=${r.status} body=${r.text.slice(0, 200)}`);
  return true;
}

async function testVaultSync() {
  console.log(`\n${BOLD}--- Vault Sync (GCP Secret Manager) ---${RESET}`);
  const testKey = `E2E_PAPRWORK_${Date.now()}`;

  const r1 = await request("POST", "/vault/sync", {
    scope: "user",
    keys: [{ name: testKey, value: "paprwork-e2e-secret" }],
  });
  check("vault/sync → 200", r1.status === 200, `status=${r1.status} body=${r1.text.slice(0, 300)}`);
  if (r1.status === 200) {
    check("vault/sync creates key", r1.data.created?.includes(testKey), `created=${JSON.stringify(r1.data.created)}`);
    check("vault/sync synced=1", r1.data.synced === 1, `synced=${r1.data.synced}`);
  }

  const r2 = await request("POST", "/vault/sync", {
    scope: "user",
    keys: [{ name: testKey, value: "updated-value" }],
  });
  if (r2.status === 200) {
    check("vault/sync updates existing", r2.data.updated?.includes(testKey), `updated=${JSON.stringify(r2.data.updated)}`);
  }

  const r3 = await request("GET", "/vault/keys?scope=user");
  check("vault/keys → 200", r3.status === 200, `status=${r3.status}`);
  if (r3.status === 200) {
    check("vault/keys contains test key", r3.data.keys?.some((k) => k.name === testKey),
      `keys=${JSON.stringify(r3.data.keys?.map((k) => k.name).slice(0, 10))}`);
  }

  return testKey;
}

async function testReposInit() {
  console.log(`\n${BOLD}--- Repos Init (GitHub papr-work org) ---${RESET}`);

  const r1 = await request("POST", "/repos/init", {
    scope: "user",
    template: "default",
  });

  check("repos/init → 200", r1.status === 200, `status=${r1.status} body=${r1.text.slice(0, 300)}`);
  if (r1.status === 200) {
    check("repos/init returns repoUrl", !!r1.data.repoUrl, `data=${JSON.stringify(r1.data)}`);
    check("repos/init points to papr-work org", r1.data.repoUrl?.includes("papr-work"), `repoUrl=${r1.data.repoUrl}`);
    check("repos/init returns defaultBranch=main", r1.data.defaultBranch === "main", `branch=${r1.data.defaultBranch}`);

    const r2 = await request("POST", "/repos/init", { scope: "user", template: "default" });
    if (r2.status === 200) {
      check("repos/init idempotent (created=false)", r2.data.created === false, `created=${r2.data.created}`);
    }
  }
}

async function testReposToken() {
  console.log(`\n${BOLD}--- Repos Token ---${RESET}`);

  const r1 = await request("POST", "/repos/token", { scope: "user" });
  check("repos/token → 200", r1.status === 200, `status=${r1.status} body=${r1.text.slice(0, 300)}`);
  if (r1.status === 200) {
    check("repos/token has token", !!r1.data.token, `keys=${Object.keys(r1.data)}`);
    check("repos/token has repos list", Array.isArray(r1.data.repos), `type=${typeof r1.data.repos}`);
    check("repos/token has expiresAt", !!r1.data.expiresAt, `expiresAt=${r1.data.expiresAt}`);
    if (r1.data.repos?.length > 0) {
      check("repos/token repo has scope", !!r1.data.repos[0].scope, `repo=${JSON.stringify(r1.data.repos[0])}`);
    }
  }
}

async function testGitCloneWithToken() {
  console.log(`\n${BOLD}--- Git Clone with Token ---${RESET}`);

  const r1 = await request("POST", "/repos/token", { scope: "user" });
  if (r1.status !== 200 || !r1.data.token || !r1.data.repos?.length) {
    skip("git clone with token", "No token or repos available");
    return;
  }

  const token = r1.data.token;
  const cloneUrl = r1.data.repos[0].cloneUrl;
  const authedUrl = cloneUrl.replace("https://", `https://x-access-token:${token}@`);

  const { execSync } = await import("child_process");
  try {
    const output = execSync(`git ls-remote --heads "${authedUrl}" 2>&1`, { timeout: 15000 }).toString();
    check("git ls-remote succeeds with token", output.includes("refs/heads/"), `output=${output.slice(0, 100)}`);
  } catch (e) {
    check("git ls-remote succeeds with token", false, e.message.slice(0, 200));
  }
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${BOLD}${CYAN}Cloud E2E Test — Paprwork → Memory Server → GCP/GitHub${RESET}`);
  console.log(`Gateway: ${gateway}`);
  console.log(`Flow: Browser/Test → Paprwork Gateway (:18789) → Memory Server (:5001) → GCP/GitHub`);
  console.log("=".repeat(70));

  await testGatewayHealth();

  const authOk = await testProxyAuth();
  if (!authOk) {
    console.log(`\n${YELLOW}Auth failed — remaining tests will be skipped.${RESET}`);
    console.log("Fix: Login with Papr in the Paprwork app, or check PAPR_MEMORY_SERVER_URL.");
    process.exit(1);
  }

  await testVaultSync();
  await testReposInit();
  await testReposToken();
  await testGitCloneWithToken();

  console.log(`\n${"=".repeat(70)}`);
  const total = passed + failed + skipped;
  console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}, ${YELLOW}${skipped} skipped${RESET} / ${total} total`);

  if (failed > 0) {
    console.log(`\n${RED}Some tests failed!${RESET}`);
    process.exit(1);
  } else {
    console.log(`\n${GREEN}All tests passed!${RESET}`);
  }
}

main().catch((e) => {
  console.error(`${RED}Fatal error:${RESET}`, e);
  process.exit(1);
});
