#!/usr/bin/env node
/**
 * Capture a workspace-log since-response from memory server for replay CI fixtures.
 *
 * Usage:
 *   node scripts/capture-workspace-log-sample.mjs \
 *     --replica-id=j-abc12345 \
 *     --cursor=0 \
 *     --out=tests/fixtures/workspace-log/prod-sample-1.json
 *
 * Requires PAPR_API_KEY (or CustomKeys) and PAPR_MEMORY_URL (default http://localhost:5001).
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

function parseArgs(argv) {
  const args = { replicaId: "", cursor: 0, out: "" };
  for (const arg of argv) {
    if (arg.startsWith("--replica-id=")) args.replicaId = arg.slice("--replica-id=".length);
    else if (arg.startsWith("--cursor=")) args.cursor = Number(arg.slice("--cursor=".length));
    else if (arg.startsWith("--out=")) args.out = arg.slice("--out=".length);
  }
  return args;
}

const { replicaId, cursor, out } = parseArgs(process.argv.slice(2));
if (!replicaId || !out) {
  console.error(
    "Usage: node scripts/capture-workspace-log-sample.mjs --replica-id=j-xxx --out=tests/fixtures/workspace-log/sample.json [--cursor=0]",
  );
  process.exit(1);
}

const apiKey = process.env.PAPR_API_KEY ?? loadApiKeyFromSettings();
if (!apiKey) {
  console.error("Set PAPR_API_KEY (env or Papr login) to capture from memory server.");
  process.exit(1);
}

function loadApiKeyFromSettings() {
  const settingsPath = join(homedir(), "Papr", "data", "settings.json");
  if (!existsSync(settingsPath)) {
    return null;
  }
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    return settings?.customKeys?.PAPR_API_KEY ?? settings?.paprProfile?.apiKey ?? null;
  } catch {
    return null;
  }
}

const baseUrl = (
  process.env.PAPR_MEMORY_URL ??
  process.env.PAPR_MEMORY_SERVER_URL ??
  "http://localhost:5001"
).replace(/\/$/, "");
const qs = new URLSearchParams({
  replicaId,
  cursor: String(cursor),
  limit: "500",
});
const url = `${baseUrl}/v1/cloud/workspace/log/since?${qs.toString()}`;

const res = await fetch(url, {
  headers: { "X-API-Key": apiKey, Accept: "application/json" },
});
if (!res.ok) {
  console.error(`Fetch failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  process.exit(1);
}

const body = await res.json();
const fixture = {
  description: `Prod capture ${new Date().toISOString()} replica=${replicaId} cursor=${cursor}`,
  ...body,
};

const outPath = resolve(out);
writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
console.log(`Wrote ${outPath} (${fixture.entries?.length ?? 0} entries)`);
