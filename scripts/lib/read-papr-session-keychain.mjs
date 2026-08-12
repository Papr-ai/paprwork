#!/usr/bin/env node
/**
 * Read Papr Parse session + user id from Papr Work secure storage.
 * Run via Electron WITHOUT ELECTRON_RUN_AS_NODE.
 *
 * Exit 0 + stdout = JSON { sessionToken, userId, displayName?, profileImage? }
 * Exit 2 = not logged in, exit 1 = error.
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

  const { CustomKeysStorage, SettingsStorage } = await importDist(
    "core/storage/index.js",
  );

  const customKeysStorage = new CustomKeysStorage();
  await customKeysStorage.initialize();

  const settingsStorage = new SettingsStorage();
  const profile = settingsStorage.getPaprProfile();

  const sessionFromKey =
    (await customKeysStorage.getKeyByName("PAPR_SESSION_TOKEN"))?.trim() || "";
  const sessionToken = sessionFromKey || profile?.sessionToken?.trim() || "";
  const userId = profile?.userId?.trim() || "";

  if (!sessionToken || !userId) {
    app.quit();
    process.exit(2);
  }

  process.stdout.write(
    JSON.stringify({
      sessionToken,
      userId,
      displayName: profile?.displayName?.trim() || "",
      profileImage: profile?.profileImage?.trim() || "",
    }),
  );
  app.quit();
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  app.quit?.();
  process.exit(1);
});
