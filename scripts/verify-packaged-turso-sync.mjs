#!/usr/bin/env node
/**
 * Verify a packaged build contains the Turso Sync engine binding for its
 * OS/CPU — or, on a platform with no upstream build, that it is correctly
 * absent (those builds use cloud-direct).
 *
 * The gateway decides replica vs cloud-direct from an OS/CPU table
 * (tursoReplicaEnabled.ts), not by probing the filesystem. So if a build that
 * should carry the engine ships without it, every database on that build would
 * fail to open. This check makes that a release failure instead.
 *
 * Usage:
 *   node scripts/verify-packaged-turso-sync.mjs <resourcesDir> <platform> <arch>
 *   e.g. release/mac-arm64/Papr\ Work.app/Contents/Resources darwin arm64
 *        release/win-unpacked/resources win32 x64
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const TABLE = {
  "darwin-arm64": "sync-darwin-arm64",
  "win32-x64": "sync-win32-x64-msvc",
  "linux-x64": "sync-linux-x64-gnu",
  "linux-arm64": "sync-linux-arm64-gnu",
};

const [, , resourcesDir, platform, arch] = process.argv;
if (!resourcesDir || !platform || !arch) {
  console.error("usage: verify-packaged-turso-sync.mjs <resourcesDir> <platform> <arch>");
  process.exit(2);
}

const expected = TABLE[`${platform}-${arch}`] ?? null;
const roots = [
  join(resourcesDir, "app.asar.unpacked", "node_modules", "@tursodatabase"),
  join(resourcesDir, "app", "node_modules", "@tursodatabase"),
  join(resourcesDir, "app.asar", "node_modules", "@tursodatabase"),
];

function findPackage(name) {
  for (const root of roots) {
    const dir = join(root, name);
    if (existsSync(dir)) {
      const hasNode = readdirSync(dir).some((f) => f.endsWith(".node"));
      return { dir, hasNode };
    }
  }
  return null;
}

if (!expected) {
  console.log(
    `[verify-packaged-turso-sync] ✓ ${platform}-${arch} has no upstream engine build — cloud-direct is used`,
  );
  process.exit(0);
}

const found = findPackage(expected);
if (!found) {
  console.error(
    `[verify-packaged-turso-sync] ✗ @tursodatabase/${expected} missing from ${resourcesDir}. ` +
      "Replica databases would fail to open on this build.",
  );
  process.exit(1);
}
if (!found.hasNode) {
  console.error(
    `[verify-packaged-turso-sync] ✗ @tursodatabase/${expected} present at ${found.dir} but has no .node binary`,
  );
  process.exit(1);
}
console.log(`[verify-packaged-turso-sync] ✓ @tursodatabase/${expected} at ${found.dir}`);
