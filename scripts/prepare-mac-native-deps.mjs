#!/usr/bin/env node
/**
 * Swap macOS optional native packages to match the Electron target arch.
 *
 * CI builds arm64 and x64 in separate jobs (isolated node_modules). On Apple Silicon
 * runners, `npm ci` only installs host-arch optional deps — run this script before
 * packaging so each job bundles the correct darwin-* native packages.
 *
 * Usage (from repo root, after npm ci + npm run build):
 *   node scripts/prepare-mac-native-deps.mjs arm64   # default host — strip x64-only clutter
 *   node scripts/prepare-mac-native-deps.mjs x64     # before Intel electron-builder
 */

import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const NODE_MODULES = join(ROOT, "node_modules");

/** @typedef {"arm64" | "x64"} MacArch */

/** @type {Record<MacArch, { install: string[]; remove: string[] }>} */
const MAC_NATIVE_PACKAGES = {
  arm64: {
    install: [
      "@libsql/darwin-arm64@0.4.7",
      "@esbuild/darwin-arm64@0.25.12",
      "@img/sharp-darwin-arm64@0.34.5",
      "@img/sharp-libvips-darwin-arm64@1.2.4",
      "@tursodatabase/sync-darwin-arm64@0.7.2",
    ],
    remove: [
      "@libsql/darwin-x64",
      "@esbuild/darwin-x64",
      "@img/sharp-darwin-x64",
      "@img/sharp-libvips-darwin-x64",
    ],
  },
  x64: {
    install: [
      "@libsql/darwin-x64@0.4.7",
      "@esbuild/darwin-x64@0.25.12",
      "@img/sharp-darwin-x64@0.34.5",
      "@img/sharp-libvips-darwin-x64@1.2.4",
    ],
    remove: [
      "@libsql/darwin-arm64",
      "@esbuild/darwin-arm64",
      "@img/sharp-darwin-arm64",
      "@img/sharp-libvips-darwin-arm64",
      "@tursodatabase/sync-darwin-arm64",
    ],
  },
};

/** Electron native modules that must be rebuilt per target arch. */
const ELECTRON_REBUILD_MODULES = ["better-sqlite3", "keytar", "sqlite3"];

/**
 * @param {string} specifier e.g. "@libsql/darwin-arm64@0.4.7" or "@libsql/darwin-x64"
 * @returns {string}
 */
function scopedPackageName(specifier) {
  const versionAt = specifier.indexOf("@", 1);
  return versionAt === -1 ? specifier : specifier.slice(0, versionAt);
}

/** All macOS optional native packages — stripped before each arch swap. */
const ALL_MAC_NATIVE_PACKAGES = [
  ...new Set([
    ...MAC_NATIVE_PACKAGES.arm64.install.map(scopedPackageName),
    ...MAC_NATIVE_PACKAGES.arm64.remove,
    ...MAC_NATIVE_PACKAGES.x64.install.map(scopedPackageName),
    ...MAC_NATIVE_PACKAGES.x64.remove,
  ]),
];

function log(message) {
  console.log(`[prepare-mac-native-deps] ${message}`);
}

function removePackage(name) {
  const dir = join(NODE_MODULES, name);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    log(`removed ${name}`);
  }
}

/**
 * @param {MacArch} arch
 */
function prepareMacNativeDeps(arch) {
  if (process.platform !== "darwin") {
    console.error("[prepare-mac-native-deps] Must run on macOS");
    process.exit(1);
  }

  const spec = MAC_NATIVE_PACKAGES[arch];
  if (!spec) {
    console.error(`[prepare-mac-native-deps] Unknown arch: ${arch} (use arm64 or x64)`);
    process.exit(1);
  }

  log(`preparing node_modules for darwin-${arch}`);

  for (const name of ALL_MAC_NATIVE_PACKAGES) {
    removePackage(name);
  }

  if (spec.install.length > 0) {
    log(`installing: ${spec.install.join(", ")}`);
    // Apple Silicon CI builds Intel packages too — optional native packages are
    // prebuilt binaries, so --force + --ignore-scripts bypasses EBADPLATFORM.
    const crossArchInstall =
      arch === "x64" && process.arch !== "x64" ? "--force --ignore-scripts" : "";
    execSync(`npm install --no-save ${crossArchInstall} ${spec.install.join(" ")}`, {
      cwd: ROOT,
      stdio: "inherit",
    });
  }

  log(`rebuilding Electron natives for ${arch}`);
  execSync(
    `npx @electron/rebuild -a ${arch} -w ${ELECTRON_REBUILD_MODULES.join(",")}`,
    { cwd: ROOT, stdio: "inherit" },
  );

  log(`done — node_modules ready for darwin-${arch} packaging`);
}

const archArg = process.argv[2]?.trim();
if (!archArg || (archArg !== "arm64" && archArg !== "x64")) {
  console.error("Usage: node scripts/prepare-mac-native-deps.mjs <arm64|x64>");
  process.exit(1);
}

prepareMacNativeDeps(archArg);
