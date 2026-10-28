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
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

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

/** Dev profile (npm run dev:devenv) owns papr-dev:// so it never takes production's papr:// links. */
const URL_SCHEME = (process.env.PAPR_PROFILE || "").trim().toLowerCase() === "dev" ? "papr-dev" : "papr";

/**
 * Declare papr:// (or papr-dev:// for the dev profile) on the dev Electron.app. Without it macOS routes papr:// links (login callback,
 * "Open in Papr" from Claude) to an installed Papr Work.app instead of the build you're running,
 * and setAsDefaultProtocolClient("papr") can't claim a scheme the bundle doesn't declare.
 */
function ensurePaprUrlScheme(plistPath) {
  const current = runPlistBuddy(["-c", "Print :CFBundleURLTypes:0:CFBundleURLSchemes:0", plistPath]);
  if (current.status === 0 && current.stdout.trim() === URL_SCHEME) return false;
  runPlistBuddy(["-c", "Delete :CFBundleURLTypes", plistPath]);
  for (const cmd of [
    "Add :CFBundleURLTypes array",
    "Add :CFBundleURLTypes:0 dict",
    "Add :CFBundleURLTypes:0:CFBundleURLName string com.paprwork.dev",
    "Add :CFBundleURLTypes:0:CFBundleURLSchemes array",
    `Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string ${URL_SCHEME}`,
  ]) {
    if (runPlistBuddy(["-c", cmd, plistPath]).status !== 0) {
      console.warn(`[patch-electron-dev-plist] Failed: ${cmd}`);
      return false;
    }
  }
  // Re-read the bundle so LaunchServices sees the new scheme before Electron claims it.
  spawnSync(LSREGISTER, ["-f", path.dirname(path.dirname(plistPath))], { stdio: "ignore" });
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

  if (ensurePaprUrlScheme(plistPath)) {
    console.log(`[patch-electron-dev-plist] Declared ${URL_SCHEME}:// on the dev Electron.app`);
  }

  if (changed > 0) {
    console.log(
      `[patch-electron-dev-plist] Updated ${changed} dev Info.plist key(s) (geolocation)`,
    );
  }
}

main();
