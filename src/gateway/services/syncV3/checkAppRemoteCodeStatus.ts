/**
 * Lightweight cloud metadata check — writer HEAD (MongoDB) vs local cursor/OIDs.
 * Does not clone git, pull files, or reconcile Turso.
 */

import { fetchAppRepoHead } from "./AppOpsClient.js";
import { writeAppRepoCommitCursor } from "./appRepoCommittedFanout.js";
import { isLocalAppCodeAtRemoteHead } from "./appRepoHeadSyncCheck.js";
import { ensureAppRepoRecord, getAppRepoRecord } from "./AppRepoClient.js";

export interface AppRemoteCodeStatus {
  appId: string;
  /** Local matches remote HEAD — no pull needed. */
  upToDate: boolean;
  remoteCommitSha: string | null;
  reason: string;
  checkFailed?: boolean;
}

export async function checkAppRemoteCodeStatus(
  appId: string,
): Promise<AppRemoteCodeStatus> {
  const trimmed = appId.trim();
  const empty: AppRemoteCodeStatus = {
    appId: trimmed,
    upToDate: true,
    remoteCommitSha: null,
    reason: "appId required",
  };

  if (!trimmed) {
    return empty;
  }

  let record = await getAppRepoRecord(trimmed);
  if (!record) {
    try {
      record = await ensureAppRepoRecord(trimmed);
    } catch {
      return {
        ...empty,
        upToDate: true,
        reason: "no per-app repo registered",
      };
    }
  }

  let head;
  try {
    head = await fetchAppRepoHead(trimmed, { seedOidCache: false });
  } catch (err) {
    return {
      appId: trimmed,
      upToDate: true,
      remoteCommitSha: null,
      reason: (err as Error).message.slice(0, 160),
      checkFailed: true,
    };
  }

  const upToDate = await isLocalAppCodeAtRemoteHead(trimmed, head);
  if (upToDate) {
    await writeAppRepoCommitCursor(trimmed, head.commitSha);
    return {
      appId: trimmed,
      upToDate: true,
      remoteCommitSha: head.commitSha,
      reason: "already at remote head",
    };
  }

  return {
    appId: trimmed,
    upToDate: false,
    remoteCommitSha: head.commitSha,
    reason: "cloud has newer app code",
  };
}
