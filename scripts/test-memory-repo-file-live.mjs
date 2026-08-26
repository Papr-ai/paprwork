#!/usr/bin/env node
/**
 * Live production test: memory.papr.ai repo-file for a published mini-app.
 *
 * Usage:
 *   unset ELECTRON_RUN_AS_NODE
 *   ./node_modules/.bin/electron scripts/test-memory-repo-file-live.mjs \
 *     [--namespace=85ZIB7mD1V] [--slug=audit-workbench] [--path=dist/app.js]
 */

import fs from "node:fs";
import path from "node:path";
import electron from "electron";

const { app, safeStorage } = electron;

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v];
  }),
);

const namespaceId = args.namespace ?? "85ZIB7mD1V";
const slug = args.slug ?? "audit-workbench";
const relativePath = args.path ?? "dist/app.js";
const orgId = args.org ?? "Y8D4H7Yp3Z";
const memoryBase = args.memory ?? "https://memory.papr.ai";

function loadEnvLocal() {
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const eq = trimmed.indexOf("=");
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    /* optional */
  }
}

async function readApiKey() {
  const keysFile = path.join(
    app.getPath("userData"),
    "data",
    "orgs",
    orgId,
    "custom-keys.json",
  );
  const data = JSON.parse(fs.readFileSync(keysFile, "utf8"));
  const names = [`PAPR_API_KEY__${namespaceId}`, "PAPR_API_KEY"];
  for (const name of names) {
    const entry = Object.values(data).find((k) => k?.name === name);
    if (entry?.encryptedValue) {
      return safeStorage.decryptString(Buffer.from(entry.encryptedValue, "base64"));
    }
  }
  throw new Error(`No API key found for org ${orgId} namespace ${namespaceId}`);
}

async function main() {
  app.setName("Papr Work");
  await app.whenReady();
  loadEnvLocal();

  const hostKey = process.env.PAPR_CLOUD_APP_HOST_KEY?.trim();
  if (!hostKey) {
    throw new Error("PAPR_CLOUD_APP_HOST_KEY missing (.env.local)");
  }

  const apiKey = await readApiKey();
  console.log(`[test] memory=${memoryBase} namespace=${namespaceId} slug=${slug} path=${relativePath}`);
  console.log(`[test] apiKey=${apiKey.slice(0, 28)}...`);

  const publishRes = await fetch(
    `${memoryBase}/v1/cloud/apps/publish/c2ab1b37-cf43-41c7-8999-3e9677f1f58b`,
    { headers: { "X-API-Key": apiKey } },
  );
  const publishText = await publishRes.text();
  console.log(`[test] publish GET ${publishRes.status}: ${publishText.slice(0, 180)}`);

  const repoRes = await fetch(`${memoryBase}/v1/cloud/apps/runtime/repo-file`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
      "X-Cloud-App-Host-Key": hostKey,
    },
    body: JSON.stringify({ namespaceId, slug, relativePath }),
  });
  const repoText = await repoRes.text();
  console.log(`[test] repo-file ${repoRes.status}: ${repoText.slice(0, 280)}`);

  if (repoRes.status === 200) {
    const body = JSON.parse(repoText);
    const bytes = Buffer.byteLength(body.content ?? "", "utf8");
    console.log(`[test] OK contentType=${body.contentType} bytes=${bytes}`);
    app.quit();
    process.exit(0);
  }

  app.quit();
  process.exit(1);
}

main().catch((err) => {
  console.error("[test] fatal:", err instanceof Error ? err.message : String(err));
  app.quit?.();
  process.exit(1);
});
