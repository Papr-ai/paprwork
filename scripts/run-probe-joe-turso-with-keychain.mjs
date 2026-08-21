#!/usr/bin/env node
/**
 * Resolve PAPR_API_KEY from keychain, then run Joe Turso replica probe.
 */
import { spawnSync, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { resolvePaprApiKeyFromKeychain } from "./lib/resolvePaprApiKeyFromKeychain.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

async function main() {
  process.env.PAPR_HOME =
    process.env.PAPR_HOME?.trim() ??
    "/Users/amirkabbara/Papr/orgs/Y8D4H7Yp3Z/namespaces/85ZIB7mD1V";
  process.env.PAPR_ORG_ID = process.env.PAPR_ORG_ID?.trim() ?? "Y8D4H7Yp3Z";
  process.env.PAPR_NAMESPACE_ID =
    process.env.PAPR_NAMESPACE_ID?.trim() ?? "85ZIB7mD1V";

  // Respect explicit local memory URL for dev E2E; default to prod when unset.
  if (!process.env.PAPR_MEMORY_SERVER_URL?.trim()) {
    process.env.PAPR_MEMORY_SERVER_URL = "https://memory.papr.ai";
  }

  const apiKey = await resolvePaprApiKeyFromKeychain();

  const fs = await import("node:fs");
  try {
    const settings = JSON.parse(
      fs.readFileSync(
        path.join(process.env.PAPR_HOME, "data", "settings.json"),
        "utf8",
      ),
    );
    const userId =
      settings.profile?.paprUserId?.trim() ??
      settings.paprProfile?.userId?.trim();
    if (userId) process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID = userId;
  } catch {
    /* optional */
  }

  if (electron.app?.quit) {
    await electron.app.quit();
  }

  const nodeBin = (() => {
    try {
      return execSync("command -v node", { encoding: "utf8" }).trim();
    } catch {
      return "node";
    }
  })();

  const child = spawnSync(
    nodeBin,
    [path.join(root, "scripts/probe-joe-turso-replicas.mjs")],
    {
      cwd: root,
      env: { ...process.env, PAPR_API_KEY: apiKey },
      stdio: "inherit",
    },
  );
  process.exit(child.status ?? 1);
}

main().catch(async (err) => {
  console.error("[ProbeJoeTurso] fatal:", err.message);
  try {
    await electron.app.quit();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
