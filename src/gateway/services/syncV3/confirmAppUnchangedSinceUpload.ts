/**
 * Second-stage check behind the cheap mtime/size folder hash.
 *
 * The folder hash says "something was saved since the last upload", not
 * "something changed". A file re-saved with identical bytes (sharing list
 * rewritten after publish, a formatter, an agent re-writing the same file)
 * flipped the app to "Unpublished changes" with nothing to publish.
 *
 * When the cheap check trips, this reads ONLY the files saved after the last
 * upload and compares them to the blob OIDs recorded when they were uploaded.
 * Cost scales with how many files were touched, not with app size. If all of
 * them match, the folder hash is re-baselined so the next check is cheap again.
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
const MAX_BYTES_TO_VERIFY = 5 * 1024 * 1024;

/** appId → folder hash already proven to differ (skip re-reading on every poll). */
const knownChangedHash = new Map<string, string>();

interface TouchedFile {
  repoPath: string;
  fullPath: string;
  size: number;
}

/** A deleted file leaves no mtime behind — check every uploaded path still exists. */
async function anyUploadedFileMissing(
  appDir: string,
  appRelative: string,
  cachedOids: Readonly<Record<string, string>>,
): Promise<boolean> {
  for (const repoPath of Object.keys(cachedOids)) {
    const top = repoPath.split("/")[0] ?? "";
    if (top === "jobs" || top === "databases") continue;
    if (isExcludedFromFolderContentHash(`${appRelative}/${repoPath}`)) continue;
    const exists = await fs.stat(path.join(appDir, repoPath)).then(
      (s) => s.isFile(),
      () => false,
    );
    if (!exists) return true;
  }
  return false;
}

async function listFilesSavedSince(
  appDir: string,
  appRelative: string,
  sinceMs: number,
): Promise<TouchedFile[] | null> {
  const touched: TouchedFile[] = [];
  let bytes = 0;
  async function walk(dir: string, prefix: string): Promise<boolean> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      const repoPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isExcludedFromFolderContentHash(`${appRelative}/${repoPath}`)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!(await walk(fullPath, repoPath))) return false;
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(fullPath).catch(() => null);
      if (!stat || isTooLargeForGitSync(stat.size) || stat.mtimeMs <= sinceMs) continue;
      touched.push({ repoPath, fullPath, size: stat.size });
      bytes += stat.size;
      if (touched.length > MAX_FILES_TO_VERIFY || bytes > MAX_BYTES_TO_VERIFY) {
        return false;
      }
    }
    return true;
  }
  return (await walk(appDir, "")) ? touched : null;
}

/**
 * True when the app folder only *looks* changed (re-saved, identical bytes).
 * On true, the stored folder hash has been re-baselined.
 */
export async function confirmAppUnchangedSinceUpload(
  paprDir: string,
  appId: string,
  stateManager: SyncStateManager,
): Promise<boolean> {
  const relativePath = `apps/${appId}`;
  const prev = stateManager.data.syncedItems[relativePath];
  const sinceMs = parseFolderHashLatestMtime(prev?.contentHash);
  if (!prev || sinceMs === null) return false;

  const currentHash = stateManager.computeContentHash(relativePath);
  if (knownChangedHash.get(appId) === currentHash) return false;
  const markChanged = (): false => {
    knownChangedHash.set(appId, currentHash);
    return false;
  };

  const cachedOids = (await readOidCache()).apps[appId];
  if (!cachedOids) return markChanged();

  const appDir = path.join(paprDir, relativePath);
  // New files have no uploaded OID and show up below as touched; deletions
  // have to be checked explicitly.
  if (await anyUploadedFileMissing(appDir, relativePath, cachedOids)) {
    return markChanged();
  }

  const touched = await listFilesSavedSince(appDir, relativePath, sinceMs);
  if (!touched) return markChanged();

  for (const file of touched) {
    const uploadedOid = cachedOids[file.repoPath];
    if (!uploadedOid) return markChanged();
    const content = await fs.readFile(file.fullPath, "utf8").catch(() => null);
    if (content === null) return markChanged();
    if ((await computeBlobOidForContent(content)) !== uploadedOid) return markChanged();
  }

  knownChangedHash.delete(appId);
  return stateManager.rebaselineContentHash(relativePath, currentHash);
}

/** Test hook. */
export function resetConfirmAppUnchangedMemo(): void {
  knownChangedHash.clear();
}
