#!/usr/bin/env node
/**
 * Verify bundled job-sdk Python modules are unpacked from app.asar.
 *
 * Python child processes cannot read inside ASAR archives. job-sdk must live
 * under app.asar.unpacked so PYTHONPATH works for platform/browser jobs.
 *
 * Usage:
 *   node scripts/verify-packaged-job-sdk.mjs release/mac-arm64/Papr\ Work.app
 *   node scripts/verify-packaged-job-sdk.mjs release/win-unpacked
 *   node scripts/verify-packaged-job-sdk.mjs release/linux-unpacked
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** @param {string} message */
function fail(message) {
  console.error(`[verify-packaged-job-sdk] ✗ ${message}`);
  process.exit(1);
}

/** @param {string} message */
function ok(message) {
  console.log(`[verify-packaged-job-sdk] ✓ ${message}`);
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

const REQUIRED_JOB_SDK_FILES = [
  "papr_platform_browser.py",
  "papr_db.py",
  "papr_files.py",
];

const appPath = process.argv[2];
if (!appPath) {
  console.error(
    "Usage: node scripts/verify-packaged-job-sdk.mjs <packaged-app-path>",
  );
  process.exit(1);
}

const asarUnpacked = resolveAsarUnpackedRoot(appPath);
const sdkRoot = join(asarUnpacked, "dist/resources/job-sdk");

if (!existsSync(sdkRoot)) {
  fail(`Missing unpacked job-sdk directory: ${sdkRoot}`);
}

let failed = false;
for (const fileName of REQUIRED_JOB_SDK_FILES) {
  const filePath = join(sdkRoot, fileName);
  if (!existsSync(filePath)) {
    console.error(
      `[verify-packaged-job-sdk] ✗ Missing dist/resources/job-sdk/${fileName}`,
    );
    failed = true;
  }
}

const srcSdkRoot = join(asarUnpacked, "src/resources/job-sdk");
if (!existsSync(srcSdkRoot)) {
  console.error(
    "[verify-packaged-job-sdk] ✗ Missing unpacked src/resources/job-sdk (dev fallback path)",
  );
  failed = true;
}

if (failed) {
  process.exit(1);
}

ok(
  `Verified job-sdk (${REQUIRED_JOB_SDK_FILES.length} modules) unpacked in ${appPath}`,
);
