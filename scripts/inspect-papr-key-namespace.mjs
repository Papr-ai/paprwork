#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseScope(key) {
  const m = key.match(/^sk-org-([^-]+)-namespace-([^-]+)/);
  if (!m) return "legacy/unscoped key";
  return `org=${m[1]} ns=${m[2]} ns8=${m[2].replace(/-/g, "").slice(0, 8).toLowerCase()}`;
}

async function main() {
  await electron.app.whenReady();
  const orgId = process.env.PAPR_ORG_ID?.trim() ?? "Y8D4H7Yp3Z";
  const activeNs = process.env.PAPR_NAMESPACE_ID?.trim() ?? "85ZIB7mD1V";
  const activeNs8 = activeNs.replace(/-/g, "").slice(0, 8).toLowerCase();

  console.log("Active workspace pointer:");
  try {
    const pointer = JSON.parse(
      fs.readFileSync(path.join(process.env.HOME ?? "", "Papr", ".active-workspace.json"), "utf8"),
    );
    console.log(`  namespaceId: ${pointer.namespaceId}`);
    console.log(`  namespaceName: ${pointer.namespaceName ?? "(none)"}`);
    console.log(`  expected ns8: ${String(pointer.namespaceId).replace(/-/g, "").slice(0, 8).toLowerCase()}`);
  } catch (err) {
    console.log(`  (could not read pointer: ${err.message})`);
  }

  console.log("\nKeychain Papr API key slots:");
  const userData =
    process.env.PAPR_USER_DATA?.trim() ??
    path.join(
      process.env.HOME ?? "",
      "Library/Application Support/Papr Work",
    );
  const keysFile = path.join(userData, "data", "orgs", orgId, "custom-keys.json");
  const data = JSON.parse(fs.readFileSync(keysFile, "utf8"));
  for (const entry of Object.values(data)) {
    const name = String(entry?.name ?? "");
    if (!name.includes("PAPR_API_KEY")) continue;
    const enc = entry?.encryptedValue;
    if (!enc) {
      console.log(`  ${name}: (empty)`);
      continue;
    }
    const key = electron.safeStorage.decryptString(Buffer.from(enc, "base64"));
    const scope = parseScope(key);
    const slotNs = name.startsWith("PAPR_API_KEY__") ? name.slice("PAPR_API_KEY__".length) : null;
    const match = slotNs ? slotNs === activeNs : "n/a";
    console.log(`  ${name}`);
    console.log(`    key scope: ${scope}`);
    if (slotNs) console.log(`    slot vs active: ${match ? "MATCH" : `MISMATCH (slot=${slotNs}, active=${activeNs})`}`);
  }

  console.log(`\nTurso segment check:`);
  console.log(`  85ZIB7mD1V -> 85zib7md (where your data lives)`);
  console.log(`  onnNQFe3DN -> onnnqfe3 (what memory API returned)`);

  await electron.app.quit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
