#!/usr/bin/env node
/**
 * Resolve PAPR_API_KEY (env / .env.local / keychain without ELECTRON_RUN_AS_NODE),
 * then run the target script under Electron for native module ABI compatibility.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadEnvLocal, resolvePaprApiKey } from "./testEnv.mjs";

const script = process.argv[2];
const forwardArgs = process.argv.slice(3);
if (!script) {
  console.error("Usage: node scripts/lib/run-e2e-with-papr-key.mjs <script.mjs> [--namespace=...]");
  process.exit(1);
}

loadEnvLocal();

const namespaceFromArgs = forwardArgs
  .find((a) => a.startsWith("--namespace="))
  ?.split("=")[1]
  ?.trim();
if (namespaceFromArgs && !process.env.PAPR_E2E_NAMESPACE_ID?.trim()) {
  process.env.PAPR_E2E_NAMESPACE_ID = namespaceFromArgs;
}
if (
  !process.env.PAPR_E2E_NAMESPACE_ID?.trim() &&
  script.includes("team-collaborate-install")
) {
  process.env.PAPR_E2E_NAMESPACE_ID = "VIA2C5VDxj";
}

const resolved = await resolvePaprApiKey();
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
if (process.env.PAPR_E2E_NAMESPACE_ID?.trim()) {
  env.PAPR_E2E_NAMESPACE_ID = process.env.PAPR_E2E_NAMESPACE_ID.trim();
}
delete env.ELECTRON_RUN_AS_NODE;

console.log(`[run-e2e] API key from ${resolved.source}, launching under Electron: ${script}`);

const result = spawnSync(
  electronBin,
  [target, ...forwardArgs],
  {
    cwd: process.cwd(),
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
