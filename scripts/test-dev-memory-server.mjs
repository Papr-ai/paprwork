#!/usr/bin/env node
/**
 * Quick smoke test for deployed memory server (dev/prod).
 * Reads PAPR_API_KEY from Papr Work keychain via Electron safeStorage.
 *
 * Usage:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/test-dev-memory-server.mjs
 *   PAPR_MEMORY_SERVER_URL=https://memoryserver-development-....run.app \
 *     ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/test-dev-memory-server.mjs
 */

import fs from "fs";
import path from "path";
import electron from "electron";

const { app, safeStorage } = electron;
const baseUrl = (
  process.env.PAPR_MEMORY_SERVER_URL ?? "https://memoryserver-development-223473570766.us-west1.run.app"
).replace(/\/$/, "");

async function getPaprApiKey() {
  if (process.env.PAPR_API_KEY) return process.env.PAPR_API_KEY;
  await app.whenReady();
  const keysFile = path.join(app.getPath("userData"), "data", "custom-keys.json");
  const data = JSON.parse(fs.readFileSync(keysFile, "utf8"));
  const entry = data.keys?.find((k) => k.name === "PAPR_API_KEY");
  if (!entry) throw new Error("PAPR_API_KEY not in keychain — login with Papr first");
  return safeStorage.decryptString(Buffer.from(entry.encryptedValue, "base64"));
}

async function call(method, route, apiKey, body) {
  const resp = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
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

function pass(name, ok, detail = "") {
  console.log(ok ? `  ✓ ${name}` : `  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

async function main() {
  console.log(`\nMemory server smoke test → ${baseUrl}\n`);

  const apiKey = await getPaprApiKey();
  console.log(`API key: ${apiKey.slice(0, 24)}...\n`);

  const health = await fetch(`${baseUrl}/health`);
  pass("GET /health", health.ok, `status=${health.status}`);

  const list = await call("POST", "/v1/cloud/databases/list", apiKey, {});
  pass("POST /v1/cloud/databases/list", list.status === 200, `status=${list.status} ${list.text.slice(0, 200)}`);

  if (list.status === 200) {
    const names = list.data?.databases?.map((d) => d.name) ?? [];
    console.log(`  databases: ${names.join(", ") || "(none)"}`);
  }

  const token = await call("POST", "/v1/cloud/databases/token", apiKey, { database: "data" });
  pass("POST /v1/cloud/databases/token (data)", token.status === 200, `status=${token.status} ${token.text.slice(0, 200)}`);

  if (token.status === 200) {
    pass("token has tursoUrl", !!token.data?.tursoUrl);
    pass("token has authToken", !!token.data?.authToken);
  }

  const vault = await call("GET", "/v1/cloud/vault/keys?scope=user", apiKey);
  pass("GET /v1/cloud/vault/keys", vault.status === 200, `status=${vault.status} ${vault.text.slice(0, 120)}`);

  if (app?.quit) app.quit();
  process.exit(list.status === 200 && token.status === 200 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  if (app?.quit) app.quit();
  process.exit(1);
});
