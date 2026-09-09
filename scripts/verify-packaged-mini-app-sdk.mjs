#!/usr/bin/env node
/**
 * Verify prebuilt mini-app SDK bundles are present inside a packaged app.
 *
 * Usage:
 *   node scripts/verify-packaged-mini-app-sdk.mjs release/mac-arm64/Papr\ Work.app
 *   node scripts/verify-packaged-mini-app-sdk.mjs release/win-unpacked
 *   node scripts/verify-packaged-mini-app-sdk.mjs release/linux-unpacked
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MIN_BYTES = 200;

/** @param {string} message */
function fail(message) {
  console.error(`[verify-packaged-mini-app-sdk] ✗ ${message}`);
  process.exit(1);
}

/** @param {string} message */
function ok(message) {
  console.log(`[verify-packaged-mini-app-sdk] ✓ ${message}`);
}

/**
 * @param {string} appPath
 * @returns {string}
 */
function resolveAsarUnpackedRoot(appPath) {
  const candidates = [
    join(appPath, "Contents/Resources/app.asar.unpacked"),
    join(appPath, "resources/app.asar.unpacked"),
    join(appPath, "app.asar.unpacked"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  fail(
    `Could not find app.asar.unpacked under ${appPath} (expected Mac .app or win/linux unpacked dir)`,
  );
}

const appPath = process.argv[2];
if (!appPath) {
  console.error(
    "Usage: node scripts/verify-packaged-mini-app-sdk.mjs <packaged-app-path>",
  );
  process.exit(1);
}

const asarUnpacked = resolveAsarUnpackedRoot(appPath);
const sdkRoot = join(asarUnpacked, "dist/resources/mini-app-sdk");
const manifestPath = join(sdkRoot, "sdk-manifest.js");
const bundledDir = join(sdkRoot, "bundled");

if (!existsSync(manifestPath)) {
  fail(`Missing SDK manifest in packaged app: ${manifestPath}`);
}

const { MINI_APP_SDK_MODULES } = await import(pathToFileURL(manifestPath).href);

let failed = false;
for (const mod of MINI_APP_SDK_MODULES) {
  const bundleName = mod.file.replace(/\.ts$/, ".js");
  const bundlePath = join(bundledDir, bundleName);
  if (!existsSync(bundlePath)) {
    console.error(`[verify-packaged-mini-app-sdk] ✗ Missing bundled/${bundleName}`);
    failed = true;
    continue;
  }
  const size = statSync(bundlePath).size;
  if (size < MIN_BYTES) {
    console.error(
      `[verify-packaged-mini-app-sdk] ✗ bundled/${bundleName} too small (${size} bytes)`,
    );
    failed = true;
  }
}

const bundledCount = existsSync(bundledDir)
  ? readdirSync(bundledDir).filter((name) => name.endsWith(".js")).length
  : 0;

if (bundledCount !== MINI_APP_SDK_MODULES.length) {
  fail(
    `Bundle count mismatch: found ${bundledCount}, expected ${MINI_APP_SDK_MODULES.length}`,
  );
}

const srcSdkRoot = join(asarUnpacked, "src/resources/mini-app-sdk");
if (!existsSync(srcSdkRoot)) {
  fail(`Missing unpacked src/resources/mini-app-sdk in packaged app`);
}

if (failed) {
  process.exit(1);
}

ok(
  `Verified ${MINI_APP_SDK_MODULES.length} mini-app SDK bundles in ${appPath}`,
);
