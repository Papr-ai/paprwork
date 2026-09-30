#!/usr/bin/env node
/**
 * Run workspace-log genesis using PAPR_API_KEY from Papr Work keychain.
 * Requires Electron safeStorage (run via Electron binary, not plain node).
 */
import fs from "node:fs";
import path from "node:path";
import electron from "electron";
import { runWorkspaceLogGenesisCutoverForAllLinkedSources } from "../src/gateway/services/syncV3/workspaceLogGenesisCutover.js";

const { app, safeStorage } = electron;

async function resolvePaprApiKey(namespaceId) {
  if (process.env.PAPR_API_KEY?.trim()) {
    return process.env.PAPR_API_KEY.trim();
  }
  await app.whenReady();
  const orgId = process.env.PAPR_ORG_ID?.trim() ?? "Y8D4H7Yp3Z";
  const keysFile = path.join(
    app.getPath("userData"),
    "data",
    "orgs",
    orgId,
    "custom-keys.json",
  );
  const data = JSON.parse(fs.readFileSync(keysFile, "utf8"));
  const entries = Object.values(data);
  const scopedName = namespaceId ? `PAPR_API_KEY__${namespaceId}` : "PAPR_API_KEY";
  const entry =
    entries.find((k) => k.name === scopedName) ??
    entries.find((k) => k.name === "PAPR_API_KEY");
  if (!entry?.encryptedValue) {
    throw new Error("PAPR_API_KEY not in keychain — login with Papr first");
  }
  return safeStorage.decryptString(Buffer.from(entry.encryptedValue, "base64"));
}

async function main() {
  const paprHome =
    process.env.PAPR_HOME?.trim() ??
    "/Users/amirkabbara/Papr/orgs/Y8D4H7Yp3Z/namespaces/85ZIB7mD1V";
  process.env.PAPR_HOME = paprHome;
  process.env.PAPR_ORG_ID = process.env.PAPR_ORG_ID?.trim() ?? "Y8D4H7Yp3Z";
  process.env.PAPR_NAMESPACE_ID =
    process.env.PAPR_NAMESPACE_ID?.trim() ?? "85ZIB7mD1V";

  process.env.PAPR_API_KEY = await resolvePaprApiKey(process.env.PAPR_NAMESPACE_ID);

  const summary = await runWorkspaceLogGenesisCutoverForAllLinkedSources();
  console.log(
    `[GenesisCutover] attempted=${summary.attempted} completed=${summary.completed} skipped=${summary.skipped} failed=${summary.failed}`,
  );
  for (const detail of summary.details) {
    if (detail.status === "failed" || detail.status === "completed") {
      const err = detail.error ? ` — ${detail.error}` : "";
      console.log(`  ${detail.status} ${detail.replicaId}${err}`);
    }
  }
  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[GenesisCutover] fatal:", err.message);
  process.exit(1);
});
