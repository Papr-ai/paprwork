#!/usr/bin/env node
/**
 * Fail the build if any prebuilt mini-app SDK bundle is missing or empty.
 * Used by Dockerfile.cloud-app-host after `npm run build:gateway`.
 */

import { existsSync, readdirSync, statSync } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const MANIFEST_PATH = path.join(ROOT, "dist/resources/mini-app-sdk/sdk-manifest.js");
const BUNDLED_DIR = path.join(ROOT, "dist/resources/mini-app-sdk/bundled");
const MIN_BYTES = 200;

if (!existsSync(MANIFEST_PATH)) {
  console.error(`[mini-app-sdk] Missing manifest: ${MANIFEST_PATH}`);
  process.exit(1);
}

const { MINI_APP_SDK_MODULES } = await import(pathToFileURL(MANIFEST_PATH).href);

let failed = false;
for (const mod of MINI_APP_SDK_MODULES) {
  const bundleName = mod.file.replace(/\.ts$/, ".js");
  const bundlePath = path.join(BUNDLED_DIR, bundleName);
  if (!existsSync(bundlePath)) {
    console.error(`[mini-app-sdk] Missing bundled/${bundleName} (${mod.route})`);
    failed = true;
    continue;
  }
  const size = statSync(bundlePath).size;
  if (size < MIN_BYTES) {
    console.error(
      `[mini-app-sdk] bundled/${bundleName} too small (${size} bytes) for ${mod.route}`,
    );
    failed = true;
    continue;
  }
  console.log(`[mini-app-sdk] ✓ bundled/${bundleName} (${size} bytes)`);
}

const bundledCount = readdirSync(BUNDLED_DIR).filter((name) => name.endsWith(".js")).length;
if (bundledCount !== MINI_APP_SDK_MODULES.length) {
  console.error(
    `[mini-app-sdk] Bundle count mismatch: found ${bundledCount}, expected ${MINI_APP_SDK_MODULES.length}`,
  );
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log(`[mini-app-sdk] Verified ${MINI_APP_SDK_MODULES.length} bundles`);
