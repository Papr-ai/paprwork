#!/usr/bin/env node
/**
 * E2E — app runtime meta Mongo dual-write route on memory server.
 *
 * Prerequisites:
 *   1. Memory server running with new routes:
 *        cd ../memory && poetry run uvicorn main:app --host 127.0.0.1 --port 5001
 *   2. PAPR_API_KEY in env or Papr login
 *
 * Usage:
 *   node scripts/test-app-runtime-meta-e2e.mjs
 *   PAPR_MEMORY_SERVER_URL=http://127.0.0.1:5001 node scripts/test-app-runtime-meta-e2e.mjs
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const memoryBase = (
  process.env.PAPR_MEMORY_SERVER_URL ?? "http://127.0.0.1:5001"
).replace(/\/$/, "");

function loadApiKey() {
  if (process.env.PAPR_API_KEY?.trim()) return process.env.PAPR_API_KEY.trim();
  for (const settingsPath of [
    join(homedir(), "Papr", "data", "settings.json"),
    join(homedir(), ".paprwork-v2", "settings.json"),
  ]) {
    try {
      if (!existsSync(settingsPath)) continue;
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const key =
        settings?.customKeys?.PAPR_API_KEY ??
        settings?.paprProfile?.apiKey ??
        null;
      if (key) return key;
    } catch {
      /* try next */
    }
  }
  return null;
}

const apiKey = loadApiKey();
if (!apiKey) {
  console.error("❌ PAPR_API_KEY required");
  process.exit(1);
}

const appId = `e2e-runtime-meta-${randomUUID()}`;
const updatedAt = new Date().toISOString();
const payload = {
  schemaVersion: "1.0.0",
  distRevision: "e2eabc1234567890",
  requiredSchemaVersion: "e2e-migration-marker",
  updatedAt,
};

async function main() {
  const health = await fetch(`${memoryBase}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`❌ Memory server not reachable at ${memoryBase}/health`);
    console.error("   Start: cd ../memory && poetry run uvicorn main:app --host 127.0.0.1 --port 5001");
    process.exit(1);
  }
  console.log(`✅ Memory server healthy at ${memoryBase}`);

  const headers = {
    "Content-Type": "application/json",
    "X-API-Key": apiKey,
    "X-Client-Type": "papr_plugin",
  };

  const putUrl = `${memoryBase}/v1/cloud/metadata/apps/${encodeURIComponent(appId)}/runtime-meta`;
  const putRes = await fetch(putUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify(payload),
  });
  const putText = await putRes.text();
  if (!putRes.ok) {
    console.error(`❌ PUT ${putUrl} → ${putRes.status}: ${putText.slice(0, 200)}`);
    process.exit(1);
  }
  const putBody = JSON.parse(putText);
  if (putBody.accepted !== true) {
    console.error(`❌ PUT accepted=false: ${putText}`);
    process.exit(1);
  }
  console.log(`✅ PUT runtime-meta accepted for ${appId}`);

  const getRes = await fetch(putUrl, { headers });
  const getText = await getRes.text();
  if (!getRes.ok) {
    console.error(`❌ GET ${putUrl} → ${getRes.status}: ${getText.slice(0, 200)}`);
    process.exit(1);
  }
  const getBody = JSON.parse(getText);
  if (getBody.source !== "mongo") {
    console.error(`❌ Expected source=mongo, got ${getBody.source}: ${getText}`);
    process.exit(1);
  }
  if (getBody.distRevision !== payload.distRevision) {
    console.error(`❌ distRevision mismatch: ${getBody.distRevision}`);
    process.exit(1);
  }
  console.log(`✅ GET runtime-meta source=mongo distRevision=${getBody.distRevision}`);
  console.log("\nAll app-runtime-meta E2E checks passed.");
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
