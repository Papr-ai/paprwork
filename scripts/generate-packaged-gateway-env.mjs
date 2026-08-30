#!/usr/bin/env node
/**
 * Write build/packaged-gateway-env.json for electron-builder extraResources.
 *
 * Values resolve: process.env → packaged-gateway-env.defaults.json → skip key.
 * Release builds always emit all default keys (env overrides where set).
 * GitHub secrets are optional — defaults cover Papr production/staging services.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const outPath = resolve(repoRoot, "build/packaged-gateway-env.json");
const defaultsPath = resolve(
  repoRoot,
  "src/resources/packaged-gateway-env.defaults.json",
);

const PACKAGED_GATEWAY_KEYS = [
  "PAPR_APP_REPO_WRITER_URL",
  "PAPR_CLOUD_APP_HOST_KEY",
  "PAPR_MEMORY_SERVER_URL",
  "PAPR_TURSO_REPLICA_SYNC",
  "PAPR_TURSO_REPLICA_SYNC_ALLOW_PRODUCTION",
];

const isReleaseBuild =
  process.env.RELEASE_BUILD === "1" ||
  process.env.RELEASE_BUILD === "true" ||
  process.env.GITHUB_ACTIONS === "true";

function loadDefaults() {
  if (!existsSync(defaultsPath)) {
    console.warn(`[packaged-gateway-env] Defaults file missing: ${defaultsPath}`);
    return {};
  }
  const parsed = JSON.parse(readFileSync(defaultsPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    return {};
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of PACKAGED_GATEWAY_KEYS) {
    const value = parsed[key];
    if (typeof value === "string" && value.trim()) {
      out[key] = value.trim();
    }
  }
  return out;
}

function readEnv(key) {
  return process.env[key]?.trim() ?? "";
}

const defaults = loadDefaults();

/** @type {Record<string, string>} */
const payload = {};

for (const key of PACKAGED_GATEWAY_KEYS) {
  const value = readEnv(key) || defaults[key];
  if (value) {
    payload[key] = value;
  }
}

if (isReleaseBuild) {
  const missing = PACKAGED_GATEWAY_KEYS.filter((key) => !payload[key]);
  if (missing.length > 0) {
    console.error(
      `[packaged-gateway-env] Release build blocked — no value for: ${missing.join(", ")}`,
    );
    console.error(
      `[packaged-gateway-env] Set GitHub secrets or update ${defaultsPath}`,
    );
    process.exit(1);
  }
}

mkdirSync(resolve(repoRoot, "build"), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

const fromEnv = PACKAGED_GATEWAY_KEYS.filter((key) => readEnv(key));
const fromDefaults = PACKAGED_GATEWAY_KEYS.filter(
  (key) => payload[key] && !readEnv(key),
);
console.log(
  `[packaged-gateway-env] Wrote ${outPath} (${Object.keys(payload).length} key(s)` +
    `${fromEnv.length ? `, ${fromEnv.length} from env` : ""}` +
    `${fromDefaults.length ? `, ${fromDefaults.length} from defaults` : ""})`,
);
