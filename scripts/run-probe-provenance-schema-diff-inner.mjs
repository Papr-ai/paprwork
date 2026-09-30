#!/usr/bin/env node
import { spawnSync, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import electron from "electron";
import { resolvePaprApiKeyFromKeychain } from "./lib/resolvePaprApiKeyFromKeychain.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

async function main() {
  electron.app.setPath(
    "userData",
    path.join(homedir(), "Library", "Application Support", "Papr Work"),
  );

  delete process.env.PAPR_API_KEY;
  const apiKey = await resolvePaprApiKeyFromKeychain({
    orgId: "rrM3uysMYw",
    namespaceId: "HyQU6FnQW3",
  });
  console.log("[Probe] API key prefix:", apiKey.slice(0, 48), "…");

  await electron.app.quit();

  const nodeBin = execSync("command -v node", { encoding: "utf8" }).trim();
  const child = spawnSync(
    nodeBin,
    [
      path.join(root, "scripts/probe-schema-drift-diff.mjs"),
      "--local-db=/Users/amirkabbara/Papr/orgs/rrM3uysMYw/namespaces/HyQU6FnQW3/data/databases/sqa-decision-provenance/data.db",
      "--replica-id=d-8efa46c2",
      "--external-user-id=WkPutXGdqg",
    ],
    {
      cwd: root,
      env: { ...process.env, PAPR_API_KEY: apiKey },
      stdio: "inherit",
    },
  );
  process.exit(child.status ?? 1);
}

main().catch(async (err) => {
  console.error("[ProbeProvenanceSchema] fatal:", err.message);
  try {
    await electron.app.quit();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
