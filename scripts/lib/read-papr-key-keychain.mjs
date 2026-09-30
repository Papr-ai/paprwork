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
  const { paprNamespaceApiKeyName } = await importDist(
    "core/utils/paprApiKey.js",
  );

  const storage = new CustomKeysStorage();
  await storage.initialize();

  const pointer = readActiveWorkspacePointer();
  if (pointer?.organizationId) {
    await storage.setActiveOrganization(pointer.organizationId);
  }

  if (pointer?.namespaceId) {
    const namespaceKey = await storage.getKeyByName(
      paprNamespaceApiKeyName(pointer.namespaceId),
    );
    if (namespaceKey?.trim()) {
      process.stdout.write(namespaceKey.trim());
      app.quit();
      process.exit(0);
    }
  }

  const alias = await storage.getKeyByName("PAPR_API_KEY");
  if (alias?.trim()) {
    process.stdout.write(alias.trim());
    app.quit();
    process.exit(0);
  }

  app.quit();
  process.exit(2);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  app.quit?.();
  process.exit(1);
});
