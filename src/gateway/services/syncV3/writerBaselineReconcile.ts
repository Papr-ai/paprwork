/**
 * Align local writer OID cache with remote repo HEAD before push.
 *
 * Without this, the first push for a new app id (e.g. after namespace copy) sends
 * parentHash "" for paths that already exist on cloud main → 409 on README.md.
 */

import { fetchAppRepoHead } from "./AppOpsClient.js";
import { removeAppRepoCommitCursor } from "./appRepoCommittedFanout.js";
import {
  overwriteOidCacheFromHead,
  readOidCache,
  removeAppFromOidCache,
} from "./OidCache.js";
import { removeOutboxEntriesForApp } from "./SyncOutbox.js";
import { clearWriterConflictsForApp } from "./writerConflict.js";

export interface WriterBaselineReconcileResult {
  realigned: boolean;
  pathsUpdated: number;
  remoteCommitSha?: string;
}

export function oidCacheNeedsRealignWithHead(
  appCache: Record<string, string> | undefined,
  headFiles: ReadonlyArray<{ path: string; blobOid: string }>,
): boolean {
  if (headFiles.length === 0) {
    return false;
  }
  if (!appCache || Object.keys(appCache).length === 0) {
    return true;
  }
  for (const file of headFiles) {
    if (appCache[file.path] !== file.blobOid) {
      return true;
    }
  }
  return false;
}

export async function reconcileOidCacheWithRemoteHead(
  appId: string,
  headFiles: ReadonlyArray<{ path: string; blobOid: string }>,
): Promise<WriterBaselineReconcileResult> {
  const trimmed = appId.trim();
  if (!trimmed || headFiles.length === 0) {
    return { realigned: false, pathsUpdated: 0 };
  }

  const cache = await readOidCache();
  const appCache = cache.apps[trimmed];
  if (!oidCacheNeedsRealignWithHead(appCache, headFiles)) {
    return { realigned: false, pathsUpdated: 0 };
  }

  const pathsUpdated = await overwriteOidCacheFromHead(trimmed, headFiles);
  return { realigned: true, pathsUpdated };
}

/**
 * Fetch writer HEAD and realign OID cache when local baseline is missing or stale.
 * Safe to call before every push — no-op when cache already matches HEAD.
 */
export async function ensureWriterBaselineBeforePush(
  appId: string,
): Promise<WriterBaselineReconcileResult> {
  const trimmed = appId.trim();
  if (!trimmed) {
    return { realigned: false, pathsUpdated: 0 };
  }

  let head;
  try {
    head = await fetchAppRepoHead(trimmed, { seedOidCache: false });
  } catch {
    return { realigned: false, pathsUpdated: 0 };
  }

  const result = await reconcileOidCacheWithRemoteHead(trimmed, head.files);
  if (result.realigned) {
    console.log(
      `[SyncV3] Realigned writer OID baseline for ${trimmed} from remote HEAD ` +
        `(${result.pathsUpdated} path(s), commit ${head.commitSha.slice(0, 7)})`,
    );
  }

  return { ...result, remoteCommitSha: head.commitSha };
}

/**
 * Drop local writer bookkeeping for an app (OID cache, cursors, outbox, conflicts).
 * Used after namespace copy so the fork does not inherit stale publish baselines.
 */
export async function clearWriterLocalStateForApp(
  appId: string,
  paprHome?: string,
): Promise<void> {
  const trimmed = appId.trim();
  if (!trimmed) {
    return;
  }
  clearWriterConflictsForApp(trimmed);
  await removeAppFromOidCache(trimmed, paprHome);
  await removeAppRepoCommitCursor(trimmed, paprHome);
  await removeOutboxEntriesForApp(trimmed);
}
