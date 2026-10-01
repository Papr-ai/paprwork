#!/usr/bin/env node
/**
 * Read PAPR_API_KEY from Papr Work secure storage.
 * Run via Electron WITHOUT ELECTRON_RUN_AS_NODE (safeStorage requires full Electron APIs).
 *
 *   app.setName("Papr Work") must run before app.whenReady() so userData resolves correctly.
 *
 * Exit 0 + stdout = key, exit 2 = not found, exit 1 = error.
 */

import electron from "electron";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const { app } = electron;

async function importDist(modulePath) {
  const abs = join(process.cwd(), "dist", modulePath);
  return import(pathToFileURL(abs).href);
}

async function main() {
  app.setName("Papr Work");
  await app.whenReady();

  if (!electron.safeStorage?.isEncryptionAvailable?.()) {
    console.error("[read-papr-key] safeStorage encryption unavailable");
    app.quit();
    process.exit(1);
  }

  const { CustomKeysStorage } = await importDist(
    "core/storage/CustomKeysStorage.js",
  );
  const { readActiveWorkspacePointer } = await importDist(
    "core/utils/paprWorkspace.js",
  );
  const {
    paprNamespaceApiKeyName,
    parsePaprApiKeyScope,
    isInternalPaprNamespaceApiKeyName,
  } = await importDist("core/utils/paprApiKey.js");

  const storage = new CustomKeysStorage();
  await storage.initialize();

  const pointer = readActiveWorkspacePointer();
  if (pointer?.organizationId) {
    await storage.setActiveOrganization(pointer.organizationId);
  }

  const isUsablePaprApiKey = (value) => {
    const trimmed = value?.trim();
    if (!trimmed?.startsWith("sk-")) {
      return false;
    }
    return Boolean(parsePaprApiKeyScope(trimmed));
  };

  const tryWriteKey = async (name) => {
    const value = await storage.getKeyByName(name);
    if (!isUsablePaprApiKey(value)) {
      return false;
    }
    process.stdout.write(value.trim());
    app.quit();
    process.exit(0);
  };

  const candidateNames = [];
  const e2eNamespace = process.env.PAPR_E2E_NAMESPACE_ID?.trim();
  if (e2eNamespace) {
    candidateNames.push(paprNamespaceApiKeyName(e2eNamespace));
  }
  if (pointer?.namespaceId) {
    candidateNames.push(paprNamespaceApiKeyName(pointer.namespaceId));
  }
  candidateNames.push("PAPR_API_KEY");

  const listed = await storage.listKeys();
  for (const meta of listed) {
    if (isInternalPaprNamespaceApiKeyName(meta.name)) {
      candidateNames.push(meta.name);
    }
  }

  const seen = new Set();
  for (const name of candidateNames) {
    const normalized = name.trim().toUpperCase();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    if (await tryWriteKey(name)) {
      return;
    }
  }

  app.quit();
  process.exit(2);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  app.quit?.();
  process.exit(1);
});
