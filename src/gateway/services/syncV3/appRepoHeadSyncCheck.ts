/**
 * Cheap "is local app code already at remote HEAD?" using writer metadata only.
 */

import type { AppRepoHeadResponse } from "../../../core/types/appRepoWriterOps.js";
import {
  readAppRepoCommitCursors,
  type AppRepoCommitCursorStore,
} from "./appRepoCommittedFanout.js";
import { fetchAppRepoHead } from "./AppOpsClient.js";
import { overwriteOidCacheFromHead, readOidCache } from "./OidCache.js";
import {
  WRITER_SCAFFOLD_PATHS,
  isPlatformGeneratedAppPath,
  isWriterScaffoldPath,
} from "./platformGeneratedAppPaths.js";

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


/** True when the remote repo has only the creation scaffold — no published app files. */
export function isScaffoldOnlyHead(head: AppRepoHeadResponse): boolean {
  return head.files.every((file) => WRITER_SCAFFOLD_PATHS.has(file.path));
}

/** True when last-pulled commit or acked blob OIDs match remote HEAD (no git clone needed). */
export async function isLocalAppCodeAtRemoteHead(
  appId: string,
  head: AppRepoHeadResponse,
): Promise<boolean> {
  const trimmed = appId.trim();
  if (!trimmed) {
    return false;
  }

  const cursors = await readAppRepoCommitCursors();
  if (cursors[trimmed]?.lastCommitSha === head.commitSha) {
    return true;
  }

  // A brand-new writer repo holds only the bot's scaffold commit (README.md).
  // That is not "newer code on the web" — nothing has been published yet, and
  // the first publish is about to replace it. Without this, a new app shows
  // "Newer version on web" the moment it goes live, before its first commit.
  if (isScaffoldOnlyHead(head)) {
    return true;
  }

  if (head.files.length === 0) {
    return false;
  }

  const cache = await readOidCache();
  const appCache = cache.apps[trimmed];
  if (!appCache) {
    return false;
  }

  for (const file of head.files) {
    // Platform-written files never mean "newer code on the web".
    if (
      isPlatformGeneratedAppPath(file.path) ||
      (isWriterScaffoldPath(file.path) && appCache[file.path] === undefined)
    ) {
      continue;
    }
    if (appCache[file.path] !== file.blobOid) {
      return false;
    }
  }
  // A path we last saw on the web that HEAD no longer has: someone deleted it.
  const headPaths = new Set(head.files.map((file) => file.path));
  for (const cachedPath of Object.keys(appCache)) {
    if (!headPaths.has(cachedPath) && !isPlatformGeneratedAppPath(cachedPath)) {
      return false;
    }
  }

  return true;
}

/**
 * After a push or publish, align the OID cache + commit cursor with writer HEAD
 * — but only for files this computer provably has.
 *
 * HEAD can hold commits this desktop never pulled (an accepted proposal, a
 * Maintainer publish, another device). Stamping HEAD's OID onto a path whose
 * bytes on disk are older told the next pull "you already have this", so the
 * real update read as a local edit: a false conflict on a file nobody touched,
 * and Publish (pull first) stopped there for good. Same rule as
 * reconcileOidCacheWithRemoteHead: never replace a known OID with HEAD's
 * unless disk matches it.
 */
export async function realignLocalAppCodeBaseline(
  appId: string,
): Promise<{ commitSha: string; pathsReseeded: number; unpulledPaths: string[] } | null> {
  const trimmed = appId.trim();
  if (!trimmed) {
    return null;
  }
  const head = await fetchAppRepoHead(trimmed, { seedOidCache: false });
  const { plan, unpulledPaths } = await planBaselineFromHead(trimmed, head.files);
  const pathsReseeded = await overwriteOidCacheFromHead(trimmed, plan);
  // The cursor says "this computer is at HEAD". Only true when nothing in HEAD
  // is still waiting to be pulled; otherwise Get updates must still see it.
  if (unpulledPaths.length === 0) {
    const { writeAppRepoCommitCursor } = await import("./appRepoCommittedFanout.js");
    await writeAppRepoCommitCursor(trimmed, head.commitSha);
  }
  return { commitSha: head.commitSha, pathsReseeded, unpulledPaths };
}

/**
 * New OID cache for an app given writer HEAD. A path takes HEAD's OID only
 * when the local file has exactly those bytes (or we had no baseline at all
 * and the file is absent here — nothing to protect). Otherwise the previous
 * baseline is kept, and the path is reported as not yet pulled.
 */
export async function planBaselineFromHead(
  appId: string,
  headFiles: ReadonlyArray<{ path: string; blobOid: string }>,
): Promise<{
  plan: Array<{ path: string; blobOid: string }>;
  unpulledPaths: string[];
}> {
  const { promises: fs } = await import("node:fs");
  const { getPaprRoot } = await import("../../../core/utils/paprRoot.js");
  const { localPathForRepoPath } = await import("./syncDeletes.js");
  const { computeBlobOidForContent } = await import("./computeParentHash.js");
  const paprDir = getPaprRoot();
  const appCache = (await readOidCache()).apps[appId] ?? {};
  const plan: Array<{ path: string; blobOid: string }> = [];
  const unpulledPaths: string[] = [];
  for (const file of headFiles) {
    const known = appCache[file.path];
    if (known === file.blobOid || isPlatformGeneratedAppPath(file.path)) {
      plan.push(file);
      continue;
    }
    let localOid: string | null = null;
    try {
      const content = await fs.readFile(localPathForRepoPath(paprDir, appId, file.path), "utf8");
      localOid = await computeBlobOidForContent(content);
    } catch {
      localOid = null;
    }
    if (localOid === file.blobOid) {
      plan.push(file);
      continue;
    }
    // Disk differs from HEAD: keep what we last agreed on (if anything) so the
    // next pull sees "web changed, local unchanged" and applies it cleanly.
    if (known !== undefined) plan.push({ path: file.path, blobOid: known });
    if (localOid !== null || known !== undefined) unpulledPaths.push(file.path);
  }
  return { plan, unpulledPaths };
}
