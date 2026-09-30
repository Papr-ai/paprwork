/**
 * Namespace git pull helpers (read-only legacy path — no push).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { GitRunner } from "./gitRunner.js";
import type { RunGitFn } from "./gitStageScope.js";
import type { SyncStateManager } from "./syncState.js";
import {
  formatPendingUploadDeferReason,
  listPendingUploadRelativePaths,
} from "./pendingLocalUploads.js";

export async function initialClone(
  paprDir: string,
  gitRunner: GitRunner,
  git: RunGitFn,
  cloneUrl: string,
): Promise<void> {
  console.log("[CloudSync] First sync — cloning repo...");
  const tempDir = path.join(os.tmpdir(), `papr-clone-${Date.now()}`);

  try {
    await gitRunner.clone(cloneUrl, tempDir);
    if (!fs.existsSync(path.join(paprDir, ".git"))) {
      fs.cpSync(path.join(tempDir, ".git"), path.join(paprDir, ".git"), { recursive: true });
    }
    fs.rmSync(tempDir, { recursive: true, force: true });

    try {
      await git(["checkout", "HEAD", "--", "."]);
      console.log("[CloudSync] Restored working tree from cloned HEAD");
    } catch (checkoutErr) {
      console.log(
        "[CloudSync] Working tree checkout skipped:",
        (checkoutErr as Error).message.slice(0, 100),
      );
    }
  } catch (err) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }
}

export async function updateRemoteUrl(
  git: RunGitFn,
  cloneUrl: string,
  normalizeRepoIdentity: (url: string) => string,
): Promise<void> {
  const identity = normalizeRepoIdentity(cloneUrl);
  console.log(`[CloudSync] origin → ${identity}`);
  try {
    await git(["remote", "set-url", "origin", cloneUrl]);
  } catch {
    try {
      await git(["remote", "add", "origin", cloneUrl]);
    } catch {
      /* remote already exists */
    }
  }
}

export async function countUnpushedCommits(git: RunGitFn): Promise<number> {
  try {
    const count = await git(["rev-list", "--count", "origin/main..HEAD"]);
    return parseInt(count, 10) || 0;
  } catch {
    try {
      const count = await git(["rev-list", "--count", "HEAD"]);
      return parseInt(count, 10) || 0;
    } catch {
      return 0;
    }
  }
}

export async function shouldDeferGitPull(
  paprDir: string,
  stateManager: SyncStateManager,
  git: RunGitFn,
): Promise<{ defer: boolean; reason?: string }> {
  const unpushed = await countUnpushedCommits(git);
  if (unpushed > 0) {
    return { defer: true, reason: `${unpushed} unpushed commit(s)` };
  }

  const pendingPaths = listPendingUploadRelativePaths(paprDir, stateManager);
  if (pendingPaths.length > 0) {
    return {
      defer: true,
      reason: formatPendingUploadDeferReason(pendingPaths),
    };
  }

  return { defer: false };
}

export async function pullTursoLinkedSourcesAfterGitPull(): Promise<void> {
  try {
    const { syncTursoAfterGitPull } = await import("../TursoSyncBridge.js");
    await syncTursoAfterGitPull();
  } catch (err) {
    console.warn(
      "[CloudSync] Turso pull after git pull failed:",
      (err as Error).message.slice(0, 120),
    );
  }
}
