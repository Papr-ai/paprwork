#!/usr/bin/env node
/**
 * Rewrite latest-mac.yml URLs to match actual Mac zip artifacts on disk.
 *
 * electron-builder sometimes writes Papr-Work-* in the yml while zip files
 * on disk are Papr.Work-* (productName space → dot). This script fixes the
 * mismatch before GitHub release upload.
 *
 * Usage: node scripts/fix-latest-mac-yml.mjs [artifactsDir]
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";

const artifactsDir = process.argv[2] ?? "artifacts";
const ymlPath = join(artifactsDir, "latest-mac.yml");

/** GitHub Releases CDN uses dots instead of spaces in download URLs (Papr Work → Papr.Work). */
function toReleaseAssetName(localName) {
  return localName.replace(/^Papr Work/, "Papr.Work");
}

function sha512Base64(filePath) {
  const hash = createHash("sha512");
  hash.update(readFileSync(filePath));
  return hash.digest("base64");
}

function findMacZips(dir) {
  const all = readdirSync(dir).filter((name) => name.endsWith("-mac.zip"));
  // Prefer Papr.Work over Papr-Work when both exist (electron-builder naming drift)
  const byArch = new Map();
  for (const name of all) {
    const archKey = name.includes("arm64") ? "arm64" : "x64";
    const score = name.startsWith("Papr.Work")
      ? 2
      : name.startsWith("Papr-Work")
        ? 1
        : 0;
    const existing = byArch.get(archKey);
    const existingScore = existing?.startsWith("Papr.Work")
      ? 2
      : existing?.startsWith("Papr-Work")
        ? 1
        : 0;
    if (!existing || score > existingScore) {
      byArch.set(archKey, name);
    }
  }
  return [...byArch.values()].sort((a, b) => {
    const aArm = a.includes("arm64") ? 0 : 1;
    const bArm = b.includes("arm64") ? 0 : 1;
    return aArm - bArm || a.localeCompare(b);
  });
}

function parseVersionFromZip(name) {
  const match = name.match(/(\d+\.\d+\.\d+)/);
  if (!match) {
    throw new Error(`Could not parse version from zip name: ${name}`);
  }
  return match[1];
}

const zips = findMacZips(artifactsDir);
if (zips.length === 0) {
  console.error(`No *-mac.zip files found in ${artifactsDir}`);
  process.exit(1);
}

const version = parseVersionFromZip(zips[0]);
const files = zips.map((name) => {
  const fullPath = join(artifactsDir, name);
  const releaseName = toReleaseAssetName(name);
  if (releaseName !== name) {
    const releasePath = join(artifactsDir, releaseName);
    renameSync(fullPath, releasePath);
  }
  const assetPath = join(artifactsDir, releaseName);
  return {
    url: releaseName,
    sha512: sha512Base64(assetPath),
    size: statSync(assetPath).size,
  };
});

// Prefer universal/intel zip as primary path (non-arm64 if both exist)
const primary =
  files.find((f) => !f.url.includes("arm64")) ?? files[0];

const releaseDate = (() => {
  try {
    const existing = readFileSync(ymlPath, "utf8");
    const match = existing.match(/releaseDate:\s*'([^']+)'/);
    if (match) return match[1];
  } catch {
    /* no existing yml */
  }
  return new Date().toISOString();
})();

const lines = [
  `version: ${version}`,
  "files:",
  ...files.flatMap((f) => [
    `  - url: ${f.url}`,
    `    sha512: ${f.sha512}`,
    `    size: ${f.size}`,
  ]),
  `path: ${primary.url}`,
  `sha512: ${primary.sha512}`,
  `releaseDate: '${releaseDate}'`,
  "",
];

writeFileSync(ymlPath, lines.join("\n"));
console.log(`Fixed ${ymlPath}:`);
for (const f of files) {
  console.log(`  ✓ ${f.url}`);
}
