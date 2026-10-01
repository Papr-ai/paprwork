#!/usr/bin/env node
/**
 * Smoke + latency check for POST /v1/cloud/databases/token on local memory.
 *
 * Usage:
 *   PAPR_API_KEY=sk-... node scripts/test-memory-databases-token.mjs
 *   PAPR_API_KEY=sk-... node scripts/test-memory-databases-token.mjs d-abc12345 j-deadbeef
 *
 * Optional: PAPR_MEMORY_SERVER_URL (default http://localhost:5001)
 * Optional: PAPR_USER_ID as external_user_id (matches desktop acting user)
 * Optional: PAPR_APP_ID scopes shared-database ACL to one mini-app
 */

const base =
  process.env.PAPR_MEMORY_SERVER_URL?.replace(/\/$/, "") ||
  "http://localhost:5001";
const apiKey = process.env.PAPR_API_KEY?.trim();
const userId = process.env.PAPR_USER_ID?.trim();
const appId = process.env.PAPR_APP_ID?.trim();

const databases = process.argv.slice(2);
if (databases.length === 0) {
  databases.push("j-cafebabe", "d-cafebabe");
}

if (!apiKey) {
  console.error("Set PAPR_API_KEY (Papr Settings / keychain) to run this script.");
  process.exit(1);
}

async function probe(name) {
  const body = { database: name };
  if (userId) {
    body.external_user_id = userId;
  }
  if (appId) {
    body.appId = appId;
  }
  const t0 = performance.now();
  const res = await fetch(`${base}/v1/cloud/databases/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify(body),
  });
  const ms = (performance.now() - t0).toFixed(1);
  const text = await res.text();
  let preview = text.slice(0, 220);
  if (text.length > 220) {
    preview += "…";
  }
  console.log(`${name}: HTTP ${res.status} in ${ms}ms`);
  console.log(`  ${preview}`);
}

console.log(`Memory: ${base}`);
console.log(`Acting user: ${userId ?? "(none — namespace key default)"}`);
console.log(`App scope: ${appId ?? "(none — track lineages only)"}`);
for (const db of databases) {
  await probe(db);
}
