/**
 * Namespace git remote review — ff-only merge for legacy cloud metadata (pull path only).
 */

import {
  type GitRemoteReconcileResult,
  filterNamespaceReconcilePaths,
  inferGitRemoteReviewState,
  listIncomingRemoteChangedPaths,
} from "./namespaceGitReview.js";
import type { RunGitFn } from "./gitStageScope.js";

export interface GitRemoteUpdateFlags {
  gitUpdatesAvailable: boolean;
  gitUpdatesSummary: string | null;
  gitRemoteChangedPaths: string[] | null;
  gitHistoryDiverged: boolean;
  gitLocalAheadCount: number;
  gitRemoteBehindCount: number;
}

export interface CloudSyncGitRemoteHost {
  runGit: RunGitFn;
  shouldDeferGitPull: () => Promise<{ defer: boolean; reason?: string }>;
  pullTursoLinkedSourcesAfterGitPull: () => Promise<void>;
  ensureFreshToken: () => Promise<string | null>;
  updateRemoteUrl: (cloneUrl: string) => Promise<void>;
  buildAuthedUrl: (cloneUrl: string, token: string) => string;
  getTokenCloneUrl: () => string | null;
  getGitRemoteFlags: () => GitRemoteUpdateFlags;
  patchGitRemoteFlags: (patch: Partial<GitRemoteUpdateFlags>) => void;
  clearGitRemoteUpdateFlags: () => void;
  setLastSyncAt: (iso: string) => void;
  setLastError: (error: string | null) => void;
  runExclusiveGitOp: <T>(fn: () => Promise<T>) => Promise<T>;
  enforceAppOwnershipAfterPull: () => Promise<void>;
}

export function clearGitRemoteUpdateFlags(host: CloudSyncGitRemoteHost): void {
  host.patchGitRemoteFlags({
    gitUpdatesAvailable: false,
    gitUpdatesSummary: null,
    gitRemoteChangedPaths: null,
    gitHistoryDiverged: false,
    gitLocalAheadCount: 0,
    gitRemoteBehindCount: 0,
  });
}

export async function refreshGitUpdatesAvailable(
  host: CloudSyncGitRemoteHost,
): Promise<void> {
  await host.runGit(["fetch", "origin", "main"]);
  const behindRaw = await host.runGit(["rev-list", "--count", "HEAD..origin/main"]);
  const behindCount = parseInt(behindRaw.trim(), 10) || 0;
  const aheadRaw = await host.runGit(["rev-list", "--count", "origin/main..HEAD"]);
  const aheadCount = parseInt(aheadRaw.trim(), 10) || 0;
  const diverged = aheadCount > 0 && behindCount > 0;
  host.patchGitRemoteFlags({
    gitHistoryDiverged: diverged,
    gitLocalAheadCount: aheadCount,
    gitRemoteBehindCount: behindCount,
  });

  if (behindCount === 0) {
    clearGitRemoteUpdateFlags(host);
    return;
  }
  const rawPaths = await listIncomingRemoteChangedPaths(host.runGit);
  const paths = filterNamespaceReconcilePaths(rawPaths);
  const summary = await host.runGit(["log", "--oneline", "-30", "HEAD..origin/main"]);
  const summaryTrimmed = summary.trim() || null;
  const review = inferGitRemoteReviewState({
    gitUpdatesAvailable: true,
    remoteChangedPaths: paths,
    gitUpdatesSummary: summaryTrimmed,
    gitHistoryDiverged: diverged,
  });
  if (!diverged && !review.requiresReview) {
    clearGitRemoteUpdateFlags(host);
    return;
  }
  host.patchGitRemoteFlags({
    gitUpdatesAvailable: true,
    gitUpdatesSummary: summaryTrimmed ?? `${behindCount} commit(s) on cloud`,
    gitRemoteChangedPaths: paths,
  });
}

/** ff-only merge for incoming namespace git changes (pull path only). */
export async function tryAutoReconcileRemoteGitInternal(
  host: CloudSyncGitRemoteHost,
): Promise<GitRemoteReconcileResult> {
  try {
    const deferPull = await host.shouldDeferGitPull();
    if (deferPull.defer) {
      console.log(
        `[CloudSync] Git pull deferred — ${deferPull.reason ?? "local work pending"}`,
      );
      return "not_needed";
    }

    await host.runGit(["fetch", "origin", "main"]);
    const behindRaw = await host.runGit([
      "rev-list",
      "--count",
      "HEAD..origin/main",
    ]);
    const behindCount = parseInt(behindRaw.trim(), 10) || 0;
    if (behindCount === 0) {
      clearGitRemoteUpdateFlags(host);
      return "not_needed";
    }

    const aheadRaw = await host.runGit([
      "rev-list",
      "--count",
      "origin/main..HEAD",
    ]);
    const aheadCount = parseInt(aheadRaw.trim(), 10) || 0;

    if (aheadCount === 0) {
      await host.runGit(["merge", "--ff-only", "origin/main"]);
      await host.pullTursoLinkedSourcesAfterGitPull();
      clearGitRemoteUpdateFlags(host);
      host.setLastSyncAt(new Date().toISOString());
      return "merged";
    }

    await refreshGitUpdatesAvailable(host);
    return "requires_review";
  } catch (err) {
    console.warn(
      "[CloudSync] Git reconcile failed:",
      (err as Error).message.slice(0, 120),
    );
    return "merge_failed";
  }
}

export async function tryAutoReconcileRemoteGit(
  host: CloudSyncGitRemoteHost,
): Promise<GitRemoteReconcileResult> {
  return host.runExclusiveGitOp(async () => {
    const token = await host.ensureFreshToken();
    if (!token) {
      return "merge_failed";
    }
    const cloneUrl = host.getTokenCloneUrl();
    if (cloneUrl) {
      await host.updateRemoteUrl(host.buildAuthedUrl(cloneUrl, token));
    }
    return tryAutoReconcileRemoteGitInternal(host);
  });
}

/** Owner accepted remote git changes — fast-forward merge into local. */
export async function applyGitRemoteUpdates(host: CloudSyncGitRemoteHost): Promise<void> {
  return host.runExclusiveGitOp(async () => {
    const token = await host.ensureFreshToken();
    if (!token) {
      throw new Error("No token for git pull");
    }
    const cloneUrl = host.getTokenCloneUrl();
    if (cloneUrl) {
      await host.updateRemoteUrl(host.buildAuthedUrl(cloneUrl, token));
    }

    await host.runGit(["fetch", "origin", "main"]);
    const aheadRaw = await host.runGit([
      "rev-list",
      "--count",
      "origin/main..HEAD",
    ]);
    const aheadCount = parseInt(aheadRaw.trim(), 10) || 0;
    if (aheadCount > 0) {
      throw new Error(
        "Local commits would be overwritten — resolve divergence before applying remote updates",
      );
    }

    await host.runGit(["merge", "--ff-only", "origin/main"]);

    clearGitRemoteUpdateFlags(host);
    host.setLastSyncAt(new Date().toISOString());
    host.setLastError(null);

    await host.enforceAppOwnershipAfterPull();
    await host.pullTursoLinkedSourcesAfterGitPull();
    console.log("[CloudSync] Applied remote git updates (ff-only)");
  });
}
