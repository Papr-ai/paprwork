/**
 * Second-stage check behind the cheap mtime/size folder hash.
 *
 * The folder hash says "something was saved since the last upload", not
 * "something changed". A file re-saved with identical bytes (sharing list
 * rewritten after publish, a formatter, an agent re-writing the same file)
 * flipped the app to "Unpublished changes" with nothing to publish.
 *
 * Cost is bounded so large, busy apps stay cheap:
 * 1. O(1): an identical re-save keeps total size and file count. If either
 *    moved, it is a real change — no walk, no reads. Covers most real edits.
 * 2. Same shape only: one stat walk, then read just the files saved after
 *    the last upload, stopping at the first mismatch, capped at
 *    MAX_FILES_TO_VERIFY / MAX_BYTES_TO_VERIFY.
 * Runs once per app per process (startup / no-watcher reconcile in
 * appDirtyState) — live edits are tracked by the watcher instead.
 * If everything matches, the folder hash is re-baselined so the next poll
 * is back to the cheap check.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { SyncStateManager } from "../cloudSync/syncState.js";
import {
  isExcludedFromFolderContentHash,
  parseFolderHashLatestMtime,
} from "../cloudSync/syncState.js";
import { isTooLargeForGitSync } from "../cloudSync/gitSyncLimits.js";
import { computeBlobOidForContent } from "./computeParentHash.js";
import { readOidCache } from "./OidCache.js";

/** Past this, treat it as a real edit session and skip the content check. */
const MAX_FILES_TO_VERIFY = 50;
const MAX_BYTES_TO_VERIFY = 2 * 1024 * 1024;

interface FolderScan {
  /** Every counted file (repo-relative to the app). */
  allPaths: Set<string>;
  /** Files saved after the last upload. */
  touched: Array<{ repoPath: string; fullPath: string }>;
}

function sizeAndCount(hash: string): string | null {
  const parts = hash.split(":");
  return parts.length === 3 ? `${parts[1]}:${parts[2]}` : null;
}

/** One stat walk. Returns null once the touched set exceeds the caps. */
async function scanFolder(
  appDir: string,
  appRelative: string,
  sinceMs: number,
): Promise<FolderScan | null> {
  const scan: FolderScan = { allPaths: new Set(), touched: [] };
  let touchedBytes = 0;
  async function walk(dir: string, prefix: string): Promise<boolean> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const files: Array<{ repoPath: string; fullPath: string }> = [];
    for (const entry of entries) {
      const repoPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isExcludedFromFolderContentHash(`${appRelative}/${repoPath}`)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!(await walk(fullPath, repoPath))) return false;
      } else if (entry.isFile()) {
        files.push({ repoPath, fullPath });
      }
    }
    // Stat a directory's files together — sequential awaits dominated on big apps.
    const stats = await Promise.all(files.map((f) => fs.stat(f.fullPath).catch(() => null)));
    for (let i = 0; i < files.length; i++) {
      const stat = stats[i];
      if (!stat || isTooLargeForGitSync(stat.size)) continue;
      scan.allPaths.add(files[i].repoPath);
      if (stat.mtimeMs <= sinceMs) continue;
      scan.touched.push(files[i]);
      touchedBytes += stat.size;
      if (scan.touched.length > MAX_FILES_TO_VERIFY || touchedBytes > MAX_BYTES_TO_VERIFY) {
        return false;
      }
    }
    return true;
  }
  return (await walk(appDir, "")) ? scan : null;
}

/** App-folder paths the last upload recorded (jobs/schema files live elsewhere). */
function uploadedAppPaths(
  cachedOids: Readonly<Record<string, string>>,
  appRelative: string,
): Set<string> {
  const out = new Set<string>();
  for (const repoPath of Object.keys(cachedOids)) {
    const top = repoPath.split("/")[0] ?? "";
    if (top === "jobs" || top === "databases") continue;
    if (isExcludedFromFolderContentHash(`${appRelative}/${repoPath}`)) continue;
    out.add(repoPath);
  }
  return out;
}

/**
 * True when the app folder only *looks* changed (re-saved, identical bytes).
 * `currentHash` is the folder hash the caller just computed. On true, the
 * stored folder hash has been re-baselined.
 */
export async function confirmAppUnchangedSinceUpload(
  paprDir: string,
  appId: string,
  stateManager: SyncStateManager,
  currentHash: string,
): Promise<boolean> {
  const relativePath = `apps/${appId}`;
  const prev = stateManager.data.syncedItems[relativePath];
  const sinceMs = parseFolderHashLatestMtime(prev?.contentHash);
  if (!prev || sinceMs === null) return false;
  const markChanged = (): false => false;

  // 1. O(1): identical re-saves keep total size and file count.
  const prevShape = sizeAndCount(prev.contentHash);
  if (!prevShape || prevShape !== sizeAndCount(currentHash)) return markChanged();

  const cachedOids = (await readOidCache()).apps[appId];
  if (!cachedOids) return markChanged();

  // 2. One walk; read only files saved since the upload.
  const scan = await scanFolder(path.join(paprDir, relativePath), relativePath, sinceMs);
  if (!scan) return markChanged();

  // Same set of files as uploaded (catches adds/deletes/renames, in memory).
  const uploaded = uploadedAppPaths(cachedOids, relativePath);
  if (uploaded.size !== scan.allPaths.size) return markChanged();
  for (const p of scan.allPaths) if (!uploaded.has(p)) return markChanged();

  for (const file of scan.touched) {
    const content = await fs.readFile(file.fullPath, "utf8").catch(() => null);
    if (content === null) return markChanged();
    if ((await computeBlobOidForContent(content)) !== cachedOids[file.repoPath]) {
      return markChanged();
    }
  }

  return stateManager.rebaselineContentHash(relativePath, currentHash);
}
