#!/usr/bin/env node
import { spawnSync, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { resolvePaprApiKeyFromKeychain } from "./lib/resolvePaprApiKeyFromKeychain.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

async function main() {
  process.env.PAPR_ORG_ID = "Y8D4H7Yp3Z";
  process.env.PAPR_NAMESPACE_ID = "85ZIB7mD1V";
  process.env.PAPR_MEMORY_SERVER_URL = "https://memory.papr.ai";

  const apiKey = await resolvePaprApiKeyFromKeychain();
  await electron.app.quit();

  const nodeBin = execSync("command -v node", { encoding: "utf8" }).trim();
  const child = spawnSync(
    nodeBin,
    [path.join(root, "scripts/scan-all-turso-for-joe-body.mjs")],
    {
      cwd: root,
      env: { ...process.env, PAPR_API_KEY: apiKey },
      stdio: "inherit",
    },
  );
  process.exit(child.status ?? 1);
}

main().catch(console.error);
