#!/usr/bin/env node
/**
 * Remove E2E test keys from cloud vault (E2E_SHARED_*, E2E_CONFLICT_*, E2E_MEMBERS_*).
 * Local shared mirrors: click Remove in Key Vault, or run pull-shared after cloud delete.
 *
 * Usage:
 *   node scripts/cleanup-vault-e2e-keys.mjs
 *   node scripts/cleanup-vault-e2e-keys.mjs --memory=http://127.0.0.1:5001 --dry-run
 */

import { loadEnvLocal, requireMemoryAccessAsync } from "./lib/testEnv.mjs";

const E2E_PREFIXES = ["E2E_SHARED_", "E2E_CONFLICT_", "E2E_MEMBERS_"];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const memoryBase = (
  args.find((a) => a.startsWith("--memory="))?.split("=").slice(1).join("=") ??
  process.env.PAPR_MEMORY_SERVER_URL ??
  "http://127.0.0.1:5001"
).replace(/\/$/, "");

function namespaceFromApiKey(apiKey) {
  const match = apiKey.match(/namespace-([A-Za-z0-9]+)/);
  return match?.[1] ?? null;
}

function isE2eKey(name) {
  return E2E_PREFIXES.some((prefix) => name.startsWith(prefix));
}

async function memoryCall(access, method, path, body) {
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

async function main() {
  loadEnvLocal();
  process.env.PAPR_MEMORY_SERVER_URL = memoryBase;

  const access = await requireMemoryAccessAsync();
  const namespaceId =
    process.env.PAPR_NAMESPACE_ID?.trim() ??
    (access.mode === "direct" ? namespaceFromApiKey(access.apiKey) : null);

  if (!namespaceId) {
    console.error("Could not resolve namespace_id — set PAPR_NAMESPACE_ID");
    process.exit(1);
  }

  const listResp = await memoryCall(
    access,
    "GET",
    `/v1/cloud/vault/keys?scope=org&namespace_id=${encodeURIComponent(namespaceId)}`,
  );
  if (listResp.status !== 200) {
    console.error(`List keys failed (${listResp.status}): ${listResp.text.slice(0, 300)}`);
    process.exit(1);
  }

  const candidates = (listResp.data.keys ?? []).filter((k) => isE2eKey(k.name));
  if (candidates.length === 0) {
    console.log("No E2E vault keys found in org scope.");
    return;
  }

  console.log(`Found ${candidates.length} E2E key(s):`);
  for (const key of candidates) {
    console.log(`  - ${key.name} (${key.shareScope ?? "org"})`);
  }

  if (dryRun) {
    console.log("\nDry run — no keys deleted.");
    return;
  }

  const deleteResp = await memoryCall(access, "POST", "/v1/cloud/vault/delete", {
    namespace_id: namespaceId,
    keys: candidates.map((k) => ({
      name: k.name,
      shareScope: k.shareScope ?? "org",
    })),
  });

  if (deleteResp.status !== 200) {
    console.error(`Delete failed (${deleteResp.status}): ${deleteResp.text.slice(0, 300)}`);
    process.exit(1);
  }

  console.log(`\nDeleted: ${(deleteResp.data.deleted ?? []).join(", ") || "(none)"}`);
  if (deleteResp.data.not_found?.length) {
    console.log(`Not found: ${deleteResp.data.not_found.join(", ")}`);
  }
  console.log(
    "\nLocal mirrors: open Settings → Key Vault and Remove each, or pull-shared will prune stale mirrors.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
