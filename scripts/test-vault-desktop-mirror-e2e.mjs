#!/usr/bin/env node
/**
 * E2E: memory pull-shared → CustomKeysStorage.syncSharedMirrors (keychain mirror).
 *
 * Uses the same main-process code path as CUSTOM_KEYS_SYNC_SHARED IPC handling.
 *
 * Usage:
 *   node scripts/test-vault-desktop-mirror-e2e.mjs
 *   node scripts/test-vault-desktop-mirror-e2e.mjs --gateway=http://127.0.0.1:18789
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import electron from "electron";
import { loadEnvLocal } from "./lib/testEnv.mjs";

const { app } = electron;
const args = process.argv.slice(2);
const gatewayBase = (
  args.find((a) => a.startsWith("--gateway="))?.split("=")[1] ??
  "http://127.0.0.1:18789"
).replace(/\/$/, "");
const memoryBase = (
  process.env.PAPR_MEMORY_SERVER_URL ?? "http://127.0.0.1:5001"
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

function loadMemoryTestEnv() {
  try {
    const raw = readFileSync(join(process.cwd(), "../memory/.env"), "utf8");
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

async function fetchSharedKeysFromMemory() {
  const apiKey = process.env.PAPR_API_KEY?.trim();
  const namespaceId = process.env.PAPR_NAMESPACE_ID?.trim() ?? "85ZIB7mD1V";
  const actingUserId = process.env.E2E_VAULT_USER_B?.trim() ?? "WkPutXGdqg";

  if (!apiKey) {
    throw new Error("PAPR_API_KEY required (set or load from ../memory/.env TEST_X_USER_API_KEY)");
  }

  const resp = await fetch(`${memoryBase}/v1/cloud/vault/pull-shared`, {
    method: "POST",
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      namespace_id: namespaceId,
      external_user_id: actingUserId,
    }),
  });
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!resp.ok) {
    throw new Error(`pull-shared failed (${resp.status}): ${text.slice(0, 300)}`);
  }
  return { keys: data.keys ?? [], namespaceId, actingUserId };
}

async function runStorageMirrorTest() {
  console.log(`\n${BOLD}--- Desktop keychain mirror (CustomKeysStorage) ---${RESET}`);

  const { pathToFileURL } = await import("node:url");
  const dist = (p) => import(pathToFileURL(join(process.cwd(), "dist", p)).href);

  const { CustomKeysStorage } = await dist("core/storage/CustomKeysStorage.js");
  const { mapCloudVaultPermission } = await dist("core/storage/sharedVaultMirror.js");

  const { keys: remoteKeys } = await fetchSharedKeysFromMemory();
  check("Memory returned shared keys", remoteKeys.length > 0, `count=${remoteKeys.length}`);

  const testKey = remoteKeys.find((k) => String(k.name).startsWith("E2E_SHARED_"));
  if (!testKey) {
    skip("Found E2E_SHARED_* key in pull response", "seed with test-vault-pull-shared-e2e.mjs first");
    return null;
  }

  const storage = new CustomKeysStorage();
  await storage.initialize();

  const mirrors = remoteKeys.map((key) => ({
    name: key.name,
    value: key.value,
    permission: mapCloudVaultPermission(key.permission),
    clientAccess: key.clientAccess ?? "server",
    vaultAudience: key.shareScope,
    sharedOwnerUserId: key.ownerUserId,
    sharedSyncedAt: key.syncedAt,
    source: key.source === "oauth" ? "oauth" : "manual",
  }));

  const result = await storage.syncSharedMirrors(mirrors);
  check("syncSharedMirrors upserted mirrors", result.upserted > 0, `upserted=${result.upserted}`);

  const listed = await storage.listKeys({ orgOnly: true });
  const mirrorMeta = listed.find((k) => k.name === testKey.name);
  check("Mirror appears in listKeys", !!mirrorMeta, `name=${testKey.name}`);
  check("Mirror has vaultOrigin=shared", mirrorMeta?.vaultOrigin === "shared");
  check("Mirror has sharedShareScope=org", mirrorMeta?.sharedShareScope === "org");

  const value = await storage.getKeyByName(testKey.name);
  check("Mirror value readable from keychain", value === testKey.value);

  if (mirrorMeta?.id) {
    try {
      await storage.updateKey(mirrorMeta.id, { description: "should fail" });
      check("Shared mirror is read-only", false, "updateKey succeeded unexpectedly");
    } catch (err) {
      check(
        "Shared mirror is read-only",
        (err).message.includes("read-only") || (err).message.includes("shared"),
        (err).message,
      );
    }
  } else {
    skip("Shared mirror is read-only", "mirror id missing");
  }

  return testKey.name;
}

async function runGatewayVaultPullShared() {
  console.log(`\n${BOLD}--- Gateway VaultSyncService IPC path ---${RESET}`);

  try {
    const health = await fetch(`${gatewayBase}/health`);
    if (!health.ok) {
      skip("Gateway vault pull-shared", `gateway health ${health.status}`);
      return;
    }
  } catch (err) {
    skip("Gateway vault pull-shared", (err).message);
    return;
  }

  const statusResp = await fetch(`${gatewayBase}/api/vault/status`);
  const status = await statusResp.json();
  if (!status.enabled) {
    skip("POST /api/vault/pull-shared", status.reason ?? "vault sync disabled");
    return;
  }

  const pullResp = await fetch(`${gatewayBase}/api/vault/pull-shared`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const pullText = await pullResp.text();
  let pullData;
  try {
    pullData = JSON.parse(pullText);
  } catch {
    pullData = pullText;
  }

  check("POST /api/vault/pull-shared → 200", pullResp.status === 200, `status=${pullResp.status} ${pullText.slice(0, 200)}`);
  if (pullResp.status === 200) {
    console.log(
      `  ${YELLOW}ℹ upserted=${pullData.upserted ?? 0} (0 expected if Papr login key is not valid against local memory)${RESET}`,
    );
  }

  const cloudProxy = await fetch(`${gatewayBase}/api/cloud/vault/pull-shared`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ namespaceId: process.env.PAPR_NAMESPACE_ID ?? "gQzFH5snBb" }),
  });
  const cloudText = await cloudProxy.text();
  check(
    "Cloud proxy pull-shared not 404",
    cloudProxy.status !== 404,
    `status=${cloudProxy.status} ${cloudText.slice(0, 120)}`,
  );
}

async function main() {
  loadEnvLocal();
  loadMemoryTestEnv();
  if (!process.env.PAPR_API_KEY?.trim() && process.env.TEST_X_USER_API_KEY) {
    process.env.PAPR_API_KEY = process.env.TEST_X_USER_API_KEY;
  }
  if (!process.env.PAPR_NAMESPACE_ID?.trim()) {
    process.env.PAPR_NAMESPACE_ID = "85ZIB7mD1V";
  }

  console.log(`\n${BOLD}${CYAN}Vault desktop mirror E2E${RESET}`);
  console.log(`  Memory:  ${memoryBase}`);
  console.log(`  Gateway: ${gatewayBase}`);

  app.setName("Papr Work");
  await app.whenReady();

  await runStorageMirrorTest();
  await runGatewayVaultPullShared();

  console.log(`\n${BOLD}═══════════════════════════════════════════════${RESET}`);
  console.log(
    `${BOLD}${passed > 0 ? GREEN : ""}${passed} passed${RESET}, ${failed > 0 ? RED : ""}${failed} failed${RESET}, ${skipped > 0 ? YELLOW : ""}${skipped} skipped${RESET}`,
  );

  app.quit();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  app.quit?.();
  process.exit(1);
});
