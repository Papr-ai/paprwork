#!/usr/bin/env node
/**
 * Verify native .node binaries in a packaged Papr Work .app match the app executable arch.
 *
 * Usage:
 *   node scripts/verify-packaged-native-arch.mjs release/mac-x64/Papr\ Work.app
 *   node scripts/verify-packaged-native-arch.mjs release/mac-arm64/Papr\ Work.app
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @typedef {"arm64" | "x64"} MacArch */

/** @param {string} message */
function fail(message) {
  console.error(`[verify-packaged-native-arch] ✗ ${message}`);
  process.exit(1);
}

/** @param {string} message */
function ok(message) {
  console.log(`[verify-packaged-native-arch] ✓ ${message}`);
}

/**
 * @param {string} filePath
 * @returns {MacArch | "universal" | "unknown"}
 */
function detectMachArch(filePath) {
  const output = execSync(`file -b ${JSON.stringify(filePath)}`, {
    encoding: "utf8",
  }).trim();

  if (/universal binary/i.test(output)) {
    return "universal";
  }
  if (/\barm64\b/i.test(output)) {
    return "arm64";
  }
  if (/\bx86_64\b/i.test(output)) {
    return "x64";
  }
  return "unknown";
}

/**
 * @param {string} dir
 * @param {string[]} out
 */
function walkNodeFiles(dir, out) {
  if (!existsSync(dir)) {
    return;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkNodeFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".node")) {
      out.push(full);
    }
  }
}

/**
 * @param {string} appPath
 * @param {MacArch} expectedArch
 */
function verifyAppNativeArch(appPath, expectedArch) {
  const execPath = join(appPath, "Contents/MacOS/Papr Work");
  if (!existsSync(execPath)) {
    fail(`Missing executable: ${execPath}`);
  }

  const execArch = detectMachArch(execPath);
  if (execArch !== expectedArch) {
    fail(`Executable is ${execArch}, expected ${expectedArch}`);
  }
  ok(`Executable arch: ${expectedArch}`);

  const unpackedRoot = join(
    appPath,
    "Contents/Resources/app.asar.unpacked/node_modules",
  );

  const requiredScoped = [
    `@libsql/darwin-${expectedArch}`,
    `@esbuild/darwin-${expectedArch}`,
  ];
  for (const pkg of requiredScoped) {
    const pkgDir = join(unpackedRoot, ...pkg.split("/"));
    if (!existsSync(pkgDir)) {
      // esbuild may live inside asar — check there too
      if (pkg.startsWith("@esbuild/")) {
        const asarEsbuild = join(
          appPath,
          "Contents/Resources/app.asar",
        );
        if (existsSync(asarEsbuild)) {
          try {
            const listing = execSync(
              `npx --yes asar list ${JSON.stringify(asarEsbuild)}`,
              { encoding: "utf8" },
            );
            if (listing.includes(`/node_modules/${pkg}/`)) {
              ok(`Found ${pkg} inside app.asar`);
              continue;
            }
          } catch {
            /* fall through */
          }
        }
      }
      fail(`Missing required native package: ${pkg}`);
    }
    ok(`Found ${pkg}`);
  }

  const forbiddenSuffix = expectedArch === "x64" ? "arm64" : "x64";
  const forbiddenPrefixes = [
    `@libsql/darwin-${forbiddenSuffix}`,
    `@esbuild/darwin-${forbiddenSuffix}`,
    `@img/sharp-darwin-${forbiddenSuffix}`,
    `@tursodatabase/sync-darwin-${forbiddenSuffix}`,
  ];
  for (const pkg of forbiddenPrefixes) {
    const pkgDir = join(unpackedRoot, ...pkg.split("/"));
    if (existsSync(pkgDir)) {
      fail(`Wrong-arch package must not be packaged: ${pkg}`);
    }
  }
  ok(`No darwin-${forbiddenSuffix} native packages in app.asar.unpacked`);

  /** @type {string[]} */
  const nodeFiles = [];
  walkNodeFiles(unpackedRoot, nodeFiles);

  for (const nodeFile of nodeFiles) {
    const arch = detectMachArch(nodeFile);
    if (arch === "universal" || arch === "unknown") {
      continue;
    }
    if (arch !== expectedArch) {
      fail(
        `Incompatible .node (${arch} in ${expectedArch} app): ${nodeFile.replace(appPath, "Papr Work.app")}`,
      );
    }
  }
  ok(`Checked ${nodeFiles.length} .node files — all match ${expectedArch} (or universal)`);

  if (expectedArch === "x64") {
    const tursoArm = join(unpackedRoot, "@tursodatabase/sync-darwin-arm64");
    if (existsSync(tursoArm)) {
      fail("Intel build must not ship @tursodatabase/sync-darwin-arm64");
    }
    ok("Turso sync arm64 binding absent (Intel has no native sync package)");
  }
}

const appPathArg = process.argv[2];
if (!appPathArg) {
  console.error(
    "Usage: node scripts/verify-packaged-native-arch.mjs <path/to/Papr Work.app>",
  );
  process.exit(1);
}

const appPath = appPathArg.replace(/\/$/, "");
if (!existsSync(appPath) || !statSync(appPath).isDirectory()) {
  fail(`App bundle not found: ${appPath}`);
}

const execPath = join(appPath, "Contents/MacOS/Papr Work");
const execArch = detectMachArch(execPath);
if (execArch !== "arm64" && execArch !== "x64") {
  fail(`Unsupported executable arch: ${execArch}`);
}

verifyAppNativeArch(appPath, execArch);
ok(`Packaged native arch verification passed for darwin-${execArch}`);
