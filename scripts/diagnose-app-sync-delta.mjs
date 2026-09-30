#!/usr/bin/env node
/**
 * Find apps whose local fingerprint differs from .cloud-sync-state.json
 * and list hash-counted files (same rules as SyncStateManager).
 *
 * Usage:
 *   node scripts/diagnose-app-sync-delta.mjs [--app-id=UUID] [--papr-dir=PATH]
 */

import fs from "node:fs";
import path from "node:path";

const IGNORED_DIRS = new Set([
  "venv",
  ".venv",
  "node_modules",
  "__pycache__",
  "dist",
  ".versions",
  "logs",
  "chrome-profile",
]);

const HASH_IGNORED_SUFFIXES = [
  "backend/bundle.json",
  "requirements.json",
  "data/cloud-repo-head.txt",
  ".papr-cloud-revision",
  "linked-databases.json",
  "__papr__/app-meta.json",
  "__papr__/platform-catalog.json",
];

const MAX_GIT_SYNC_FILE_BYTES = 10 * 1024 * 1024;

function isLocalOnlyArtifact(baseName) {
  const lower = baseName.toLowerCase();
  return (
    lower.endsWith(".bak") ||
    lower.includes(".bak.") ||
    lower.includes(".backup.") ||
    lower.includes(".backup-") ||
    lower.includes(".sync-backup-") ||
    lower.includes(".corrupt-") ||
    lower.includes("corrupt-backup")
  );
}

function shouldExclude(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  if (
    normalized.endsWith("/job.runtime.json") ||
    normalized === "data/job-runs.jsonl"
  ) {
    return true;
  }
  if (
    HASH_IGNORED_SUFFIXES.some(
      (suffix) => normalized === suffix || normalized.endsWith(`/${suffix}`),
    )
  ) {
    return true;
  }
  const baseName = path.basename(normalized);
  if (isLocalOnlyArtifact(baseName)) return true;
  if (baseName.endsWith(".db-shm") || baseName.endsWith(".db-wal") || baseName.endsWith(".db")) {
    return true;
  }
  return false;
}

function isTooLarge(size) {
  return size > MAX_GIT_SYNC_FILE_BYTES;
}

function collectHashFiles(dirPath, relativePrefix) {
  const files = [];
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
    const entryRelative = path.join(relativePrefix, entry.name).replace(/\\/g, "/");
    if (shouldExclude(entryRelative)) continue;
    const entryPath = path.join(dirPath, entry.name);
    try {
      const stat = fs.statSync(entryPath);
      if (stat.isDirectory()) {
        files.push(...collectHashFiles(entryPath, entryRelative));
        continue;
      }
      if (isTooLarge(stat.size)) continue;
      files.push({
        relativePath: entryRelative,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    } catch {
      /* skip */
    }
  }
  return files;
}

function computeDirHash(files) {
  if (files.length === 0) return "empty";
  let latest = 0;
  let totalSize = 0;
  for (const f of files) {
    if (f.mtimeMs > latest) latest = f.mtimeMs;
    totalSize += f.size;
  }
  return `${latest}:${totalSize}:${files.length}`;
}

function resolvePaprDir() {
  const arg = process.argv.find((a) => a.startsWith("--papr-dir="));
  if (arg) return arg.slice("--papr-dir=".length);
  const activePath = path.join(process.env.HOME ?? "", "Papr", ".active-workspace.json");
  try {
    const active = JSON.parse(fs.readFileSync(activePath, "utf8"));
    if (active.paprHome) return active.paprHome;
  } catch {
    /* fall through */
  }
  return path.join(process.env.HOME ?? "", "Papr");
}

function resolveAppFilter() {
  const arg = process.argv.find((a) => a.startsWith("--app-id="));
  return arg ? arg.slice("--app-id=".length) : null;
}

const paprDir = resolvePaprDir();
const appFilter = resolveAppFilter();
const statePath = path.join(paprDir, ".cloud-sync-state.json");

let state = { syncedItems: {} };
try {
  state = JSON.parse(fs.readFileSync(statePath, "utf8"));
} catch {
  console.error(`No sync state at ${statePath}`);
  process.exit(1);
}

const appsDir = path.join(paprDir, "apps");
const appIds = appFilter
  ? [appFilter]
  : fs.readdirSync(appsDir).filter((name) => {
      try {
        return fs.statSync(path.join(appsDir, name)).isDirectory();
      } catch {
        return false;
      }
    });

console.log(`Papr dir: ${paprDir}`);
console.log(`Sync state: ${statePath}`);
console.log(`Apps scanned: ${appIds.length}\n`);

const dirty = [];

for (const appId of appIds) {
  const relativePath = `apps/${appId}`;
  const appDir = path.join(paprDir, relativePath);
  if (!fs.existsSync(appDir)) continue;

  const hashFiles = collectHashFiles(appDir, relativePath);
  const currentHash = computeDirHash(hashFiles);
  const prev = state.syncedItems?.[relativePath];
  const changed = !prev || currentHash !== prev.contentHash;

  if (!changed) continue;

  dirty.push({ appId, relativePath, currentHash, prev, hashFiles });
}

if (dirty.length === 0) {
  console.log("All scanned apps match stored sync fingerprints.");
  process.exit(0);
}

console.log(`Dirty apps: ${dirty.length}\n`);

for (const item of dirty.slice(0, appFilter ? 1 : 15)) {
  const lastSyncMs = item.prev?.lastSyncAt
    ? Date.parse(item.prev.lastSyncAt)
    : 0;
  console.log("=".repeat(72));
  console.log(`App: ${item.appId}`);
  console.log(`Stored hash: ${item.prev?.contentHash ?? "(never synced)"}`);
  console.log(`Current hash: ${item.currentHash}`);
  console.log(`Last sync at: ${item.prev?.lastSyncAt ?? "never"}`);

  const afterSync = item.hashFiles
    .filter((f) => !lastSyncMs || f.mtimeMs > lastSyncMs - 1000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const recentIgnored = [];
  function walkIgnored(dirPath, relPrefix) {
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = path.join(relPrefix, entry.name).replace(/\\/g, "/");
      const full = path.join(dirPath, entry.name);
      try {
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) {
            if (!lastSyncMs || stat.mtimeMs > lastSyncMs - 1000) {
              recentIgnored.push({
                relativePath: rel + "/",
                mtime: stat.mtime.toISOString(),
                note: "ignored dir (dist/node_modules/etc.) — does NOT drive fingerprint",
              });
            }
            continue;
          }
          walkIgnored(full, rel);
          continue;
        }
        if (shouldExclude(rel) && (!lastSyncMs || stat.mtimeMs > lastSyncMs - 1000)) {
          recentIgnored.push({
            relativePath: rel,
            mtime: stat.mtime.toISOString(),
            note: "hash-excluded cloud-prep artifact",
          });
        }
      } catch {
        /* skip */
      }
    }
  }
  walkIgnored(path.join(paprDir, item.relativePath), item.relativePath);

  console.log(`\nHash-counted files touched since last sync (${afterSync.length}):`);
  if (afterSync.length === 0) {
    console.log(
      "  (none by mtime — fingerprint drift may be from deleted files, count/size aggregate change, or never-recorded sync)",
    );
    const top = [...item.hashFiles].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 8);
    console.log("\n  Newest hash-counted files overall:");
    for (const f of top) {
      console.log(`    ${f.mtime}  ${f.relativePath}  (${f.size} bytes)`);
    }
  } else {
    for (const f of afterSync.slice(0, 20)) {
      console.log(`    ${f.mtime}  ${f.relativePath}  (${f.size} bytes)`);
    }
    if (afterSync.length > 20) {
      console.log(`    … and ${afterSync.length - 20} more`);
    }
  }

  if (recentIgnored.length > 0) {
    console.log(`\nRecently touched but EXCLUDED from fingerprint (${recentIgnored.length}):`);
    for (const f of recentIgnored.slice(0, 12)) {
      console.log(`    ${f.mtime}  ${f.relativePath}`);
      console.log(`      → ${f.note}`);
    }
  }
  console.log("");
}

if (!appFilter && dirty.length > 15) {
  console.log(`… and ${dirty.length - 15} more dirty apps. Use --app-id=UUID for one app.`);
}
