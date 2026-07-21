#!/usr/bin/env node
/**
 * Cloud Sync E2E Test — Milestone 1B
 *
 * Tests bidirectional git sync between ~/Papr and GitHub via the memory server.
 *
 * Prerequisites:
 *   1. Paprwork running: npm start (gateway on port 18789)
 *   2. Memory server running: cd memory && python3 main.py (port 5001)
 *   3. PAPR_MEMORY_SERVER_URL=http://localhost:5001 in .env.local
 *   4. CLOUD_SYNC_ENABLED not set to "false"
 *
 * Usage:
 *   node scripts/test-cloud-sync-e2e.mjs [--gateway URL]
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const args = process.argv.slice(2);
const gateway = (
  args.find((a) => a.startsWith("--gateway="))?.split("=")[1] ??
  "http://localhost:18789"
).replace(/\/$/, "");

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

async function apiGet(urlPath) {
  const resp = await fetch(`${gateway}${urlPath}`);
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: resp.status, data };
}

async function apiPost(urlPath, body = null, timeoutMs = 120_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const opts = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: controller.signal,
  };
  if (body) opts.body = JSON.stringify(body);
  try {
    const resp = await fetch(`${gateway}${urlPath}`, opts);
    clearTimeout(timer);
    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: resp.status, data };
  } catch (err) {
    clearTimeout(timer);
    return { status: 0, data: { error: err.message } };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Test 1: Gateway reachable ──────────────────────────────────────

async function testGatewayHealth() {
  console.log(`\n${BOLD}--- Gateway Health ---${RESET}`);
  try {
    const resp = await fetch(`${gateway}/health`);
    check("Gateway reachable", resp.status === 200, `status=${resp.status}`);
  } catch (e) {
    check("Gateway reachable", false, `${e.message}`);
    console.log(
      `\n${RED}Gateway not reachable. Run: npm start${RESET}`,
    );
    process.exit(1);
  }
}

// ─── Test 2: Sync status endpoint ───────────────────────────────────

async function testSyncStatus() {
  console.log(`\n${BOLD}--- Sync Status Endpoint ---${RESET}`);
  const r = await apiGet("/api/sync/status");
  check("GET /api/sync/status returns 200", r.status === 200, `status=${r.status}`);
  check(
    "Response has enabled field",
    typeof r.data.enabled === "boolean",
    `data=${JSON.stringify(r.data).slice(0, 200)}`,
  );

  if (r.data.enabled) {
    check(
      "Status is idle or syncing",
      ["idle", "syncing", "error"].includes(r.data.status),
      `status=${r.data.status}`,
    );
    console.log(`  ${CYAN}ℹ Sync status: ${r.data.status}, lastSync: ${r.data.lastSyncAt ?? "never"}${RESET}`);
  } else {
    console.log(`  ${YELLOW}ℹ Cloud sync not initialized: ${r.data.reason}${RESET}`);
  }

  return r.data;
}

// ─── Test 3: Repos token endpoint ───────────────────────────────────

async function testReposToken() {
  console.log(`\n${BOLD}--- Repos Token ---${RESET}`);
  const r = await apiPost("/api/cloud/repos/token", { scope: "user" });
  check("POST /repos/token returns 200", r.status === 200, `status=${r.status}`);

  if (r.status !== 200) {
    skip("Token has repos array", "token request failed");
    skip("Clone URL has token", "token request failed");
    return null;
  }

  check(
    "Response has repos array",
    Array.isArray(r.data.repos) && r.data.repos.length > 0,
    `repos=${JSON.stringify(r.data.repos).slice(0, 200)}`,
  );
  check(
    "Response has token",
    typeof r.data.token === "string" && r.data.token.length > 10,
    `tokenLen=${r.data.token?.length}`,
  );
  check(
    "Response has expiresAt",
    typeof r.data.expiresAt === "string",
    `expiresAt=${r.data.expiresAt}`,
  );

  const userRepo = r.data.repos?.find((r) => r.scope === "user");
  if (userRepo) {
    check(
      "User repo has cloneUrl",
      typeof userRepo.cloneUrl === "string" && userRepo.cloneUrl.includes("github.com"),
      `cloneUrl=${userRepo.cloneUrl?.slice(0, 60)}...`,
    );
    check(
      "Token can build authed clone URL",
      typeof r.data.token === "string" &&
        `https://x-access-token:${r.data.token}@${userRepo.cloneUrl.replace("https://", "")}`.includes("x-access-token:"),
      "token + cloneUrl should combine into authed URL",
    );
    console.log(`  ${CYAN}ℹ Repo: ${userRepo.repoUrl}${RESET}`);
  }

  return r.data;
}

// ─── Test 4: Clone with token ───────────────────────────────────────

function buildAuthedCloneUrl(cloneUrl, token) {
  if (cloneUrl.includes("x-access-token:")) {
    return cloneUrl.replace(/x-access-token:[^@]+/, `x-access-token:${token}`);
  }
  return cloneUrl.replace("https://", `https://x-access-token:${token}@`);
}

async function testGitClone(tokenData) {
  console.log(`\n${BOLD}--- Git Clone ---${RESET}`);
  if (!tokenData?.repos?.length || !tokenData?.token) {
    skip("Git clone", "no token data");
    return null;
  }

  const userRepo = tokenData.repos.find((r) => r.scope === "user");
  if (!userRepo?.cloneUrl) {
    skip("Git clone", "no user repo clone URL");
    return null;
  }

  const authedUrl = buildAuthedCloneUrl(userRepo.cloneUrl, tokenData.token);
  const tmpDir = path.join(os.tmpdir(), `papr-sync-test-${Date.now()}`);
  try {
    execSync(`git clone --depth 1 "${authedUrl}" "${tmpDir}"`, {
      timeout: 30_000,
      stdio: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    check("Git clone succeeds", true);

    const files = fs.readdirSync(tmpDir).filter((f) => f !== ".git");
    console.log(
      `  ${CYAN}ℹ Cloned ${files.length} files: ${files.slice(0, 10).join(", ")}${files.length > 10 ? "..." : ""}${RESET}`,
    );

    check("Clone has .git directory", fs.existsSync(path.join(tmpDir, ".git")));

    return tmpDir;
  } catch (e) {
    check("Git clone succeeds", false, e.message?.slice(0, 200));
    return null;
  }
}

// ─── Test 5: Write file + push ──────────────────────────────────────

async function testWriteAndPush(syncStatus) {
  console.log(`\n${BOLD}--- Write File + Sync Push ---${RESET}`);

  if (!syncStatus?.enabled) {
    skip("Write and push", "cloud sync not enabled");
    return;
  }

  const PAPR_DIR = path.join(os.homedir(), "Papr");
  const testFile = path.join(PAPR_DIR, "workspace", `_sync-test-${Date.now()}.md`);
  const testContent = `# Sync Test\nCreated at ${new Date().toISOString()}\n`;

  try {
    fs.mkdirSync(path.dirname(testFile), { recursive: true });
    fs.writeFileSync(testFile, testContent, "utf-8");
    check("Test file created", fs.existsSync(testFile));
    console.log(`  ${CYAN}ℹ Wrote: ${testFile}${RESET}`);
  } catch (e) {
    check("Test file created", false, e.message);
    return;
  }

  // Trigger push (may take 30-60s for large repos)
  console.log("  Triggering push (may take up to 60s)...");
  const pushR = await apiPost("/api/sync/push", null, 120_000);
  check(
    "POST /api/sync/push returns 200",
    pushR.status === 200,
    `status=${pushR.status}, data=${JSON.stringify(pushR.data).slice(0, 200)}`,
  );

  if (pushR.status === 200) {
    check(
      "Push reports success",
      pushR.data.success === true,
      `data=${JSON.stringify(pushR.data).slice(0, 200)}`,
    );
    console.log(
      `  ${CYAN}ℹ Post-push status: ${pushR.data.status}, lastSync: ${pushR.data.lastSyncAt}${RESET}`,
    );
  }

  // Clean up test file
  try {
    fs.unlinkSync(testFile);
    console.log(`  ${CYAN}ℹ Cleaned up test file${RESET}`);
  } catch {
    // non-critical
  }
}

// ─── Test 6: Verify pushed to GitHub ────────────────────────────────

async function testVerifyOnGitHub(tokenData) {
  console.log(`\n${BOLD}--- Verify on GitHub ---${RESET}`);

  if (!tokenData?.repos?.length || !tokenData?.token) {
    skip("Verify on GitHub", "no token data");
    return;
  }

  const userRepo = tokenData.repos.find((r) => r.scope === "user");
  if (!userRepo?.cloneUrl) {
    skip("Verify on GitHub", "no user repo");
    return;
  }

  const authedUrl = buildAuthedCloneUrl(userRepo.cloneUrl, tokenData.token);
  const tmpDir = path.join(os.tmpdir(), `papr-verify-${Date.now()}`);
  try {
    execSync(`git clone --depth 1 "${authedUrl}" "${tmpDir}"`, {
      timeout: 30_000,
      stdio: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });

    const log = execSync("git log --oneline -5", {
      cwd: tmpDir,
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();

    check(
      "Repo has commits",
      log.length > 0,
      "no commits found",
    );

    console.log(`  ${CYAN}ℹ Recent commits:\n${log.split("\n").map((l) => `    ${l}`).join("\n")}${RESET}`);

    const hasGitignore = fs.existsSync(path.join(tmpDir, ".gitignore"));
    check("Repo has .gitignore", hasGitignore);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {
    check("Verify on GitHub", false, e.message?.slice(0, 200));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
}

// ─── Run all ────────────────────────────────────────────────────────

// ─── Test 7: Persistent sync state ──────────────────────────────────

async function testPersistentState() {
  console.log(`\n${BOLD}--- Persistent Sync State ---${RESET}`);
  const statePath = path.join(os.homedir(), "Papr", ".cloud-sync-state.json");
  const exists = fs.existsSync(statePath);
  check("State file exists at ~/Papr/.cloud-sync-state.json", exists, "file not found");
  if (exists) {
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      check(
        "State has syncedItems object",
        typeof raw.syncedItems === "object",
        `type=${typeof raw.syncedItems}`,
      );
      const count = Object.keys(raw.syncedItems).length;
      console.log(`  ${CYAN}ℹ Synced items tracked: ${count}${RESET}`);
      if (count > 0) {
        const sample = Object.entries(raw.syncedItems).slice(0, 3);
        for (const [key, val] of sample) {
          console.log(`    ${key}: lastSync=${val.lastSyncAt}, hash=${val.contentHash?.slice(0, 30)}`);
        }
      }
    } catch (e) {
      check("State file is valid JSON", false, e.message);
    }
  }
}

// ─── Test 8: Delete detection ───────────────────────────────────────

async function testDeleteDetection(syncStatus) {
  console.log(`\n${BOLD}--- Delete Detection ---${RESET}`);
  if (!syncStatus?.enabled) {
    skip("Delete detection", "cloud sync not enabled");
    return;
  }

  const PAPR_DIR = path.join(os.homedir(), "Papr");
  const testDir = path.join(PAPR_DIR, "workspace", `_delete-test-${Date.now()}`);
  const testFile = path.join(testDir, "temp.md");

  try {
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(testFile, "# Delete test\n");
    console.log(`  ${CYAN}ℹ Created temp dir: ${testDir}${RESET}`);

    console.log("  Pushing to sync...");
    await apiPost("/api/sync/push", null, 120_000);
    await sleep(2000);

    fs.rmSync(testDir, { recursive: true });
    console.log(`  ${CYAN}ℹ Deleted temp dir${RESET}`);
    check("Test dir removed from disk", !fs.existsSync(testDir));

    console.log("  Pushing again (should detect deletion)...");
    const pushR = await apiPost("/api/sync/push", null, 120_000);
    check("Push after deletion succeeds", pushR.status === 200, `status=${pushR.status}`);
  } catch (e) {
    check("Delete detection flow", false, e.message);
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* */ }
  }
}

// ─── Test 9: Settings toggle ────────────────────────────────────────

async function testSettingsToggle() {
  console.log(`\n${BOLD}--- Settings Toggle ---${RESET}`);
  const settingsPath = path.join(os.homedir(), "Papr", "data", "settings.json");
  const exists = fs.existsSync(settingsPath);
  if (!exists) {
    skip("Settings toggle", "settings.json not found");
    return;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const cloudSync = raw?.preferences?.cloudSyncEnabled;
    check(
      "cloudSyncEnabled is defined in preferences",
      cloudSync !== undefined,
      `value=${cloudSync}`,
    );
    check(
      "cloudSyncEnabled is boolean",
      typeof cloudSync === "boolean",
      `type=${typeof cloudSync}`,
    );
    console.log(`  ${CYAN}ℹ cloudSyncEnabled = ${cloudSync}${RESET}`);
  } catch (e) {
    check("Settings file valid", false, e.message);
  }
}

// ─── Test 10: Sync status has queue info ─────────────────────────────

async function testSyncStatusExtended() {
  console.log(`\n${BOLD}--- Extended Sync Status ---${RESET}`);
  const r = await apiGet("/api/sync/status");
  if (r.status !== 200 || !r.data.enabled) {
    skip("Extended status", "sync not enabled");
    return;
  }

  check(
    "Status has queueRemaining field",
    typeof r.data.queueRemaining === "number",
    `queueRemaining=${r.data.queueRemaining}`,
  );
  check(
    "Status has queueTotal field",
    typeof r.data.queueTotal === "number",
    `queueTotal=${r.data.queueTotal}`,
  );
  console.log(
    `  ${CYAN}ℹ Queue: ${r.data.queueRemaining}/${r.data.queueTotal} remaining${RESET}`,
  );
}

// ─── Test 11: Vault status endpoint ──────────────────────────────────

async function testVaultStatus() {
  console.log(`\n${BOLD}--- Vault Status ---${RESET}`);
  const r = await apiGet("/api/vault/status");
  check("GET /api/vault/status returns 200", r.status === 200, `status=${r.status}`);
  check(
    "Response has enabled field",
    typeof r.data.enabled === "boolean",
    `data=${JSON.stringify(r.data).slice(0, 200)}`,
  );

  if (r.data.enabled) {
    check(
      "Vault status is idle, syncing, or error",
      ["idle", "syncing", "error"].includes(r.data.status),
      `status=${r.data.status}`,
    );
    check(
      "Response has keyCount",
      typeof r.data.keyCount === "number",
      `keyCount=${r.data.keyCount}`,
    );
    console.log(
      `  ${CYAN}ℹ Vault: status=${r.data.status}, keys=${r.data.keyCount}, lastSync=${r.data.lastSyncAt ?? "never"}${RESET}`,
    );
  } else {
    console.log(`  ${YELLOW}ℹ Vault sync not initialized: ${r.data.reason}${RESET}`);
  }
}

// ─── Test 12: Vault push endpoint ───────────────────────────────────

async function testVaultPush() {
  console.log(`\n${BOLD}--- Vault Push ---${RESET}`);
  const statusR = await apiGet("/api/vault/status");
  if (!statusR.data.enabled) {
    skip("Vault push", "vault sync not enabled");
    return;
  }

  const r = await apiPost("/api/vault/push", null, 30_000);
  check(
    "POST /api/vault/push returns 200",
    r.status === 200,
    `status=${r.status}, data=${JSON.stringify(r.data).slice(0, 200)}`,
  );

  if (r.status === 200) {
    check("Push reports success", r.data.success === true, `data=${JSON.stringify(r.data).slice(0, 200)}`);
    if (r.data.result) {
      console.log(
        `  ${CYAN}ℹ Synced: ${r.data.result.synced} keys (${r.data.result.created?.length ?? 0} created, ${r.data.result.updated?.length ?? 0} updated)${RESET}`,
      );
    }
  }

  // Verify vault keys via cloud proxy
  const keysR = await apiGet("/api/cloud/vault/keys?scope=user");
  if (keysR.status === 200) {
    check(
      "Vault keys endpoint returns keys array",
      Array.isArray(keysR.data.keys),
      `data=${JSON.stringify(keysR.data).slice(0, 200)}`,
    );
    console.log(
      `  ${CYAN}ℹ Vault key names: ${keysR.data.keys?.map((k) => k.name).join(", ") || "(none)"}${RESET}`,
    );
  } else {
    console.log(`  ${YELLOW}ℹ Could not list vault keys: status=${keysR.status}${RESET}`);
  }
}

// ─── Run all ────────────────────────────────────────────────────────

console.log(`\n${BOLD}${CYAN}╔══════════════════════════════════════════════════╗${RESET}`);
console.log(`${BOLD}${CYAN}║  Cloud Sync E2E Test — 1B + 1B-h + 1C Vault     ║${RESET}`);
console.log(`${BOLD}${CYAN}╚══════════════════════════════════════════════════╝${RESET}`);
console.log(`Gateway: ${gateway}`);

await testGatewayHealth();
const syncStatus = await testSyncStatus();
const tokenData = await testReposToken();
await testGitClone(tokenData);
await testWriteAndPush(syncStatus);
await testVerifyOnGitHub(tokenData);
await testPersistentState();
await testDeleteDetection(syncStatus);
await testSettingsToggle();
await testSyncStatusExtended();
await testVaultStatus();
await testVaultPush();

// Summary
console.log(`\n${BOLD}═══════════════════════════════════════════════${RESET}`);
console.log(
  `${BOLD}${passed > 0 ? GREEN : ""}${passed} passed${RESET}, ${failed > 0 ? RED : ""}${failed} failed${RESET}, ${skipped > 0 ? YELLOW : ""}${skipped} skipped${RESET} / ${passed + failed + skipped} total`,
);

if (failed > 0) {
  console.log(`\n${RED}Some tests failed. Check output above.${RESET}`);
  process.exit(1);
}

console.log(`\n${GREEN}All sync tests passed!${RESET}`);
