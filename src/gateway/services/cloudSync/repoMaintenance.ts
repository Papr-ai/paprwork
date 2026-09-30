/**
 * Periodic git maintenance for the CloudSync repo.
 *
 * Runs three bounded steps, in order:
 *   1. Sweep orphaned repack temp files (the 207 GB failure mode).
 *   2. Untrack anything matching NEVER_TRACK_PATHSPECS — `git rm --cached`,
 *      which removes it from the index but LEAVES THE FILE ON DISK.
 *   3. Expire unreachable objects and repack.
 *
 * Step 3 uses a *generous* timeout and is skipped entirely when the repo is
 * small, because `gc` on a bloated repo is exactly what stranded the temp packs
 * in the first place. We prefer `--prune=now` without `--aggressive`:
 * aggressive repacking rewrites every pack from scratch (huge temp files, hours
 * of CPU) for marginal gain on a sync mirror.
 */

import type { GitRunner } from "./gitRunner.js";
import {
  NEVER_TRACK_PATHSPECS,
  classifyRepoSize,
  measureGitDirBytes,
  sweepStaleTmpPacks,
} from "./repoHygiene.js";

const GC_TIMEOUT_MS = 30 * 60_000;
const RM_TIMEOUT_MS = 5 * 60_000;

export interface MaintenanceResult {
  tmpPacksRemoved: number;
  tmpPackBytesReclaimed: number;
  untrackedFiles: number;
  gcRan: boolean;
  gitDirBytesBefore: number;
  gitDirBytesAfter: number;
  level: "ok" | "warn" | "critical";
}

/**
 * Untrack blobs that should never have been committed.
 *
 * Uses `git rm --cached` so the working-tree file survives — losing a user's
 * SQLite database here would be catastrophic and is not an acceptable
 * trade for repo size.
 */
export async function untrackForbiddenPaths(
  git: GitRunner,
  repoDir: string,
): Promise<number> {
  let removed = 0;
  for (const pathspec of NEVER_TRACK_PATHSPECS) {
    let listed: string;
    try {
      listed = await git.run(["ls-files", "-z", "--", `:(glob)**/${pathspec}`], {
        cwd: repoDir,
        timeout: RM_TIMEOUT_MS,
      });
    } catch {
      continue;
    }
    const files = listed.split("\0").filter(Boolean);
    if (files.length === 0) continue;

    // Chunk to stay under ARG_MAX on repos with thousands of stray blobs.
    for (let i = 0; i < files.length; i += 200) {
      const chunk = files.slice(i, i + 200);
      try {
        await git.run(["rm", "--cached", "--ignore-unmatch", "--", ...chunk], {
          cwd: repoDir,
          timeout: RM_TIMEOUT_MS,
        });
        removed += chunk.length;
      } catch {
        /* keep going — one bad pathspec shouldn't abort hygiene */
      }
    }
  }
  return removed;
}

/**
 * Run one bounded maintenance pass. Safe to call on every sync tick; the caller
 * is responsible for throttling to HYGIENE_INTERVAL_MS.
 */
export async function runRepoMaintenance(
  git: GitRunner,
  repoDir: string,
  opts: { runGc?: boolean } = {},
): Promise<MaintenanceResult> {
  const gitDirBytesBefore = measureGitDirBytes(repoDir);

  const sweep = sweepStaleTmpPacks(repoDir);
  const untrackedFiles = await untrackForbiddenPaths(git, repoDir);

  let gcRan = false;
  if (opts.runGc !== false) {
    try {
      // Not --aggressive: full rewrites create the multi-GB temp packs that
      // strand on timeout. Pruning unreachable objects is where the win is.
      await git.run(["reflog", "expire", "--expire-unreachable=now", "--all"], {
        cwd: repoDir,
        timeout: GC_TIMEOUT_MS,
      });
      await git.run(["gc", "--prune=now", "--quiet"], {
        cwd: repoDir,
        timeout: GC_TIMEOUT_MS,
      });
      gcRan = true;
    } catch (err) {
      // A killed gc strands temp packs — sweep again immediately so a failed
      // maintenance run can never be the thing that fills the disk.
      sweepStaleTmpPacks(repoDir, Date.now() + 2 * 60 * 60 * 1000);
      console.warn(
        "[CloudSync] git gc failed, temp packs swept:",
        (err as Error).message.slice(0, 160),
      );
    }
  }

  const gitDirBytesAfter = measureGitDirBytes(repoDir);
  return {
    tmpPacksRemoved: sweep.removedFiles,
    tmpPackBytesReclaimed: sweep.reclaimedBytes,
    untrackedFiles,
    gcRan,
    gitDirBytesBefore,
    gitDirBytesAfter,
    level: classifyRepoSize(gitDirBytesAfter).level,
  };
}
