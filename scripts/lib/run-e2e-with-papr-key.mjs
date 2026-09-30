#!/usr/bin/env node
/**
 * Resolve PAPR_API_KEY (env / .env.local / keychain without ELECTRON_RUN_AS_NODE),
 * then run the target script under Electron for native module ABI compatibility.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  loadEnvLocal,
  normalizePaprApiKey,
  resolvePaprApiKeyFromKeychain,
} from "./testEnv.mjs";

const script = process.argv[2];
if (!script) {
  console.error("Usage: node scripts/lib/run-e2e-with-papr-key.mjs <script.mjs>");
  process.exit(1);
}

loadEnvLocal();

async function resolveKey() {
  const fromEnv = process.env.PAPR_API_KEY?.trim();
  if (fromEnv) {
    return { key: normalizePaprApiKey(fromEnv), source: "env" };
  }
  const fromKeychain = await resolvePaprApiKeyFromKeychain();
  if (fromKeychain) {
    return { key: fromKeychain, source: "keychain" };
  }
  return null;
}

const resolved = await resolveKey();
if (!resolved) {
  console.error("❌ PAPR_API_KEY required — set in .env.local or login via Papr Work");
  process.exit(1);
}

const electronBin = join(process.cwd(), "node_modules", ".bin", "electron");
const target = join(process.cwd(), script);

const env = {
  ...process.env,
  PAPR_API_KEY: resolved.key,
};
delete env.ELECTRON_RUN_AS_NODE;

console.log(`[run-e2e] API key from ${resolved.source}, launching under Electron: ${script}`);

const result = spawnSync(
  electronBin,
  [target],
  {
    cwd: process.cwd(),
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
