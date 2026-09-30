#!/usr/bin/env node
/**
 * Decrypt namespace PAPR_API_KEY and run ledger backfill via node (not electron fetch).
 */
import { spawnSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { resolvePaprApiKeyFromKeychain } from "./lib/resolvePaprApiKeyFromKeychain.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

async function main() {
  const paprHome =
    process.env.PAPR_HOME?.trim() ??
    "/Users/amirkabbara/Papr/orgs/Y8D4H7Yp3Z/namespaces/85ZIB7mD1V";
  process.env.PAPR_HOME = paprHome;
  process.env.PAPR_ORG_ID = process.env.PAPR_ORG_ID?.trim() ?? "Y8D4H7Yp3Z";
  process.env.PAPR_NAMESPACE_ID =
    process.env.PAPR_NAMESPACE_ID?.trim() ?? "85ZIB7mD1V";

  const memoryUrl = process.env.PAPR_MEMORY_SERVER_URL?.trim();
  if (
    !memoryUrl ||
    memoryUrl.includes("127.0.0.1") ||
    memoryUrl.includes("localhost")
  ) {
    process.env.PAPR_MEMORY_SERVER_URL = "https://memory.papr.ai";
  }

  const apiKey = await resolvePaprApiKeyFromKeychain();
  await electron.app.quit();

  const settingsPath = path.join(paprHome, "data", "settings.json");
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const userId =
      settings.profile?.paprUserId?.trim() ??
      settings.paprProfile?.userId?.trim();
    if (userId) {
      process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID = userId;
    }
  } catch {
    /* optional */
  }

  const args = process.argv.slice(2);
  const nodeBin = (() => {
    try {
      return execSync("command -v node", { encoding: "utf8" }).trim();
    } catch {
      return "node";
    }
  })();
  const child = spawnSync(
    nodeBin,
    ["--import", "tsx", path.join(root, "scripts/backfill-migration-ledgers.mjs"), ...args],
    {
      cwd: root,
      env: {
        ...process.env,
        PAPR_API_KEY: apiKey,
      },
      stdio: "inherit",
    },
  );
  process.exit(child.status ?? 1);
}

main().catch(async (err) => {
  console.error("[MigrationLedgerBackfill] fatal:", err.message);
  try {
    await electron.app.quit();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
