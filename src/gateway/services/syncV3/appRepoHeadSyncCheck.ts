/**
 * Cheap "is local app code already at remote HEAD?" using writer metadata only.
 */

import type { AppRepoHeadResponse } from "../../../core/types/appRepoWriterOps.js";
import {
  readAppRepoCommitCursors,
  type AppRepoCommitCursorStore,
} from "./appRepoCommittedFanout.js";
import { readOidCache } from "./OidCache.js";

/** Skip remote HEAD fetch for preview opens when we verified recently (manual sync bypasses). */
export const RECENT_HEAD_VERIFY_MS = Number(
  process.env.APP_REPO_HEAD_VERIFY_TTL_MS ?? 120_000,
);

export function isAppCodeRecentlyVerified(
  appId: string,
  cursors: Record<string, AppRepoCommitCursorStore>,
): { verified: true; commitSha: string } | { verified: false } {
  const trimmed = appId.trim();
  const cursor = cursors[trimmed];
  if (!cursor?.lastCommitSha) {
    return { verified: false };
  }
  const ageMs = Date.now() - new Date(cursor.updatedAt).getTime();
  if (ageMs < 0 || ageMs > RECENT_HEAD_VERIFY_MS) {
    return { verified: false };
  }
  return { verified: true, commitSha: cursor.lastCommitSha };
}

/** True when last-pulled commit or acked blob OIDs match remote HEAD (no git clone needed). */
export async function isLocalAppCodeAtRemoteHead(
  appId: string,
  head: AppRepoHeadResponse,
): Promise<boolean> {
  const trimmed = appId.trim();
  if (!trimmed || head.files.length === 0) {
    return false;
  }

  const cursors = await readAppRepoCommitCursors();
  if (cursors[trimmed]?.lastCommitSha === head.commitSha) {
    return true;
  }

  const cache = await readOidCache();
  const appCache = cache.apps[trimmed];
  if (!appCache) {
    return false;
  }

  for (const file of head.files) {
    if (appCache[file.path] !== file.blobOid) {
      return false;
    }
  }

  return true;
}
