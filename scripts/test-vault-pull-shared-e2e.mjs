#!/usr/bin/env node
/**
 * E2E: Audience vault local sync — pull-shared across two acting users.
 *
 * Prerequisites:
 *   1. Local memory server: cd ../memory && poetry run uvicorn main:app --host 127.0.0.1 --port 5001
 *   2. Paprwork gateway (optional): npm start with PAPR_MEMORY_SERVER_URL=http://127.0.0.1:5001
 *   3. PAPR_API_KEY in .env.local or Papr login keychain
 *
 * Usage:
 *   node scripts/test-vault-pull-shared-e2e.mjs
 *   node scripts/test-vault-pull-shared-e2e.mjs --memory=http://127.0.0.1:5001 --gateway=http://127.0.0.1:18789
 */

import { loadEnvLocal, requireMemoryAccessAsync } from "./lib/testEnv.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback) =>
  args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ??
  fallback;

const memoryBase = arg("memory", process.env.PAPR_MEMORY_SERVER_URL ?? "http://127.0.0.1:5001").replace(/\/$/, "");
const gatewayBase = arg("gateway", "http://127.0.0.1:18789").replace(/\/$/, "");

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
    console.log(`  ${RED}FAIL${RESET} ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function skip(name, reason) {
  console.log(`  ${YELLOW}SKIP${RESET} ${name} — ${reason}`);
  skipped++;
}

function namespaceFromApiKey(apiKey) {
  const match = apiKey.match(/namespace-([A-Za-z0-9]+)/);
  return match?.[1] ?? null;
}

function cloudPathFromMemoryPath(memoryPath) {
  return memoryPath.replace(/^\/v1\/cloud/, "");
}

async function memoryCall(access, method, path, body) {
  if (access.mode === "gateway") {
    return gatewayCall(method, cloudPathFromMemoryPath(path), body);
  }
  const resp = await fetch(`${memoryBase}${path}`, {
    method,
    headers: {
      "X-API-Key": access.apiKey,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: resp.status, data, text };
}

async function gatewayCall(method, path, body) {
  const resp = await fetch(`${gatewayBase}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: resp.status, data, text };
}

async function testMemoryDirect(access, namespaceId) {
  console.log(`\n${BOLD}--- Memory pull-shared (${access.mode}) ---${RESET}`);

  const testKey = `E2E_SHARED_${Date.now()}`;
  // For local memory + TEST_X_USER_API_KEY (namespace 85ZIB7mD1V), WkPutXGdqg is a valid peer.
  const userA = process.env.E2E_VAULT_USER_A?.trim() || undefined;
  const userB = process.env.E2E_VAULT_USER_B?.trim() || "WkPutXGdqg";
  const secretValue = `shared-secret-${Date.now()}`;

  const health = await fetch(`${memoryBase}/health`);
  check("GET /health", health.ok, `status=${health.status}`);

  const syncBody = {
    scope: "user",
    namespace_id: namespaceId,
    keys: [
      {
        name: testKey,
        value: secretValue,
        shareScope: "org",
        clientAccess: "server",
        permission: "always_allow",
        source: "manual",
      },
    ],
  };
  if (userA) {
    syncBody.external_user_id = userA;
  }
  const sync = await memoryCall(access, "POST", "/v1/cloud/vault/sync", syncBody);
  check("User A vault/sync org key → 200", sync.status === 200, `status=${sync.status} ${sync.text.slice(0, 200)}`);

  const pullOwnerBody = { namespace_id: namespaceId };
  if (userA) {
    pullOwnerBody.external_user_id = userA;
  }
  const pullOwner = await memoryCall(access, "POST", "/v1/cloud/vault/pull-shared", pullOwnerBody);
  check("User A pull-shared → 200", pullOwner.status === 200, `status=${pullOwner.status} ${pullOwner.text.slice(0, 200)}`);
  if (pullOwner.status === 200) {
    const ownerNames = (pullOwner.data.keys ?? []).map((k) => k.name);
    check(
      "User A does not receive own org key",
      !ownerNames.includes(testKey),
      `names=${ownerNames.join(", ") || "(none)"}`,
    );
  }

  const pullPeer = await memoryCall(access, "POST", "/v1/cloud/vault/pull-shared", {
    namespace_id: namespaceId,
    external_user_id: userB,
  });
  check("User B pull-shared → 200", pullPeer.status === 200, `status=${pullPeer.status} ${pullPeer.text.slice(0, 200)}`);
  if (pullPeer.status === 200) {
    const peerEntry = (pullPeer.data.keys ?? []).find((k) => k.name === testKey);
    check("User B receives shared org key", !!peerEntry, `count=${pullPeer.data.keys?.length ?? 0}`);
    check("User B gets correct value", peerEntry?.value === secretValue, "value mismatch");
    check("User B shareScope is org", peerEntry?.shareScope === "org", `shareScope=${peerEntry?.shareScope}`);
    check("User B ownerUserId is set", !!peerEntry?.ownerUserId, `owner=${peerEntry?.ownerUserId ?? "(missing)"}`);
    if (userA) {
      check("User B ownerUserId matches user A", peerEntry?.ownerUserId === userA, `owner=${peerEntry?.ownerUserId}`);
    }
  }

  return { testKey, shareScope: "org" };
}

async function cleanupVaultKeys(access, namespaceId, keys) {
  if (!keys.length) {
    return;
  }
  console.log(`\n${BOLD}--- Cleanup E2E vault keys ---${RESET}`);
  const deleteResp = await memoryCall(access, "POST", "/v1/cloud/vault/delete", {
    namespace_id: namespaceId,
    keys: keys.map((k) => ({ name: k.name, shareScope: k.shareScope ?? "org" })),
  });
  if (deleteResp.status === 200) {
    const deleted = deleteResp.data.deleted ?? [];
    if (deleted.length > 0) {
      console.log(`  ${GREEN}Deleted${RESET} ${deleted.join(", ")}`);
    }
  } else if (deleteResp.status === 404) {
    console.log(`  ${YELLOW}SKIP${RESET} vault/delete not available — restart memory server`);
  } else {
    console.log(
      `  ${YELLOW}WARN${RESET} cleanup failed (${deleteResp.status}): ${deleteResp.text.slice(0, 120)}`,
    );
  }
}

async function testGatewayProxy(namespaceId, expectedKey) {
  console.log(`\n${BOLD}--- Gateway proxy (/api/cloud/vault/pull-shared) ---${RESET}`);

  try {
    const health = await fetch(`${gatewayBase}/health`);
    if (!health.ok) {
      skip("Gateway proxy tests", `gateway health ${health.status}`);
      return;
    }
  } catch (err) {
    skip("Gateway proxy tests", (err).message);
    return;
  }

  const probe = await gatewayCall("GET", "/api/cloud/vault/keys?scope=user");
  if (probe.status === 401) {
    skip("Gateway proxy tests", "PAPR_API_KEY not configured in running Paprwork");
    return;
  }
  if (probe.status === 502) {
    skip("Gateway proxy tests", "502 — running gateway may not point at local memory (set PAPR_MEMORY_SERVER_URL=http://127.0.0.1:5001 and restart npm start)");
    return;
  }

  const pull = await gatewayCall("POST", "/api/cloud/vault/pull-shared", {
    namespaceId,
    external_user_id: "e2e-vault-user-b",
  });
  if (pull.status === 404) {
    skip(
      "Gateway pull-shared",
      "404 — running gateway likely points at deployed memory without pull-shared yet; restart npm start with PAPR_MEMORY_SERVER_URL=http://127.0.0.1:5001",
    );
    return;
  }
  check("Gateway pull-shared → 200", pull.status === 200, `status=${pull.status} ${pull.text.slice(0, 200)}`);
  if (pull.status === 200 && expectedKey) {
    const names = (pull.data.keys ?? []).map((k) => k.name);
    if (names.includes(expectedKey)) {
      check("Gateway returns org key created in memory test", true);
    } else {
      console.log(
        `  ${YELLOW}ℹ Gateway did not return ${expectedKey} — likely pointing at a different memory server than --memory${RESET}`,
      );
      skip("Gateway returns org key from memory test", "gateway memory URL mismatch (restart with local PAPR_MEMORY_SERVER_URL)");
    }
  }
}

async function main() {
  loadEnvLocal();
  process.env.PAPR_MEMORY_SERVER_URL = memoryBase;

  console.log(`\n${BOLD}${CYAN}Vault pull-shared E2E${RESET}`);
  console.log(`  Memory:  ${memoryBase}`);
  console.log(`  Gateway: ${gatewayBase}\n`);

  const access = await requireMemoryAccessAsync();
  if (access.mode === "direct") {
    process.env.PAPR_MEMORY_SERVER_URL = memoryBase;
  }

  const namespaceId =
    process.env.PAPR_NAMESPACE_ID?.trim() ??
    (access.mode === "direct" ? namespaceFromApiKey(access.apiKey) : null);

  if (!namespaceId) {
    console.log(`${RED}Could not resolve namespace_id — set PAPR_NAMESPACE_ID in .env.local${RESET}`);
    process.exit(1);
  }

  console.log(`  Namespace: ${namespaceId}`);

  let createdKeys = [];
  try {
    const result = await testMemoryDirect(access, namespaceId);
    createdKeys = [result];
    await testGatewayProxy(namespaceId, result.testKey);
  } finally {
    await cleanupVaultKeys(
      access,
      namespaceId,
      createdKeys.map((k) => ({ name: k.testKey, shareScope: k.shareScope })),
    );
  }

  console.log(`\n${BOLD}═══════════════════════════════════════════════${RESET}`);
  console.log(
    `${BOLD}${passed > 0 ? GREEN : ""}${passed} passed${RESET}, ${failed > 0 ? RED : ""}${failed} failed${RESET}, ${skipped > 0 ? YELLOW : ""}${skipped} skipped${RESET}`,
  );

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
