#!/usr/bin/env node
/**
 * Patch Electron.app Info.plist for local dev (npm start / electron:dev).
 * Packaged builds get these keys from electron-builder.json extendInfo.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLIST_BUDDY = "/usr/libexec/PlistBuddy";

/** Keep in sync with electron-builder.json mac.extendInfo */
const DEV_PLIST_KEYS = {
  NSLocationWhenInUseUsageDescription:
    "Papr Work uses your location to show local weather in the sidebar.",
};

function runPlistBuddy(args) {
  return spawnSync(PLIST_BUDDY, args, { encoding: "utf8" });
}

function upsertPlistString(plistPath, key, value) {
  const existing = runPlistBuddy(["-c", `Print :${key}`, plistPath]);
  if (existing.status === 0) {
    const current = existing.stdout.trim();
    if (current === value) {
      return false;
    }
    const setResult = runPlistBuddy([
      "-c",
      `Set :${key} ${JSON.stringify(value)}`,
      plistPath,
    ]);
    if (setResult.status !== 0) {
      console.error(
        `[patch-electron-dev-plist] Failed to set ${key}:`,
        setResult.stderr.trim(),
      );
      process.exit(1);
    }
    return true;
  }

  const addResult = runPlistBuddy([
    "-c",
    `Add :${key} string ${JSON.stringify(value)}`,
    plistPath,
  ]);
  if (addResult.status !== 0) {
    console.error(
      `[patch-electron-dev-plist] Failed to add ${key}:`,
      addResult.stderr.trim(),
    );
    process.exit(1);
  }
  return true;
}

function main() {
  if (process.platform !== "darwin") {
    process.exit(0);
  }

  if (!existsSync(PLIST_BUDDY)) {
    console.log("[patch-electron-dev-plist] PlistBuddy not found, skipping");
    process.exit(0);
  }

  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const plistPath = path.join(
    root,
    "node_modules/electron/dist/Electron.app/Contents/Info.plist",
  );

  if (!existsSync(plistPath)) {
    console.log("[patch-electron-dev-plist] Electron.app Info.plist not found, skipping");
    process.exit(0);
  }

  let changed = 0;
  for (const [key, value] of Object.entries(DEV_PLIST_KEYS)) {
    if (upsertPlistString(plistPath, key, value)) {
      changed += 1;
    }
  }

  if (changed > 0) {
    console.log(
      `[patch-electron-dev-plist] Updated ${changed} dev Info.plist key(s) (geolocation)`,
    );
  }
}

main();
