/**
 * Git-native staging for CloudSync scopes.
 *
 * Git applies .gitignore when it discovers files. We stage per scope with:
 *   1. git add -u -- <scope>     updates/deletes to already-tracked files
 *   2. git ls-files -o --exclude-standard  new untracked, non-ignored files only
 *   3. size filter + git add     Papr's only pre-add gate (10MB cap)
 *   4. git add -f -- apps/{id}/dist  explicit allowlist for published bundles
 *
 * No parallel ignore list — .gitignore is the source of truth.
 */

import fs from "node:fs";
import path from "node:path";
import { isTooLargeForGitSync } from "./gitSyncLimits.js";
import { miniAppDistRelativePaths } from "./workspaceGitignore.js";

export type RunGitFn = (
  args: string[],
  opts?: { timeout?: number },
) => Promise<string>;

const ADD_CHUNK_SIZE = 200;

/** Benign when staging a scope that has never been committed (all files untracked). */
function isBenignAddUpdateFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("did not match any file(s) known to git");
}

async function stageScopeUpdates(runGit: RunGitFn, scope: string): Promise<void> {
  try {
    await runGit(["add", "-u", "--", scope]);
  } catch (err) {
    if (!isBenignAddUpdateFailure(err)) {
      throw err;
    }
  }
}

function normalizeScope(scope: string): string {
  return scope.replace(/\\/g, "/");
}

function uniqueScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map(normalizeScope).filter(Boolean))];
}

/** List new untracked files under scope that git would not ignore. */
export async function listUntrackedNonIgnoredFiles(
  runGit: RunGitFn,
  scope: string,
): Promise<string[]> {
  try {
    const listed = await runGit([
      "ls-files",
      "-o",
      "--exclude-standard",
      "-z",
      "--",
      scope,
    ]);
    return listed.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

/** Skip files over the git sync size limit before explicit add. */
export function partitionUntrackedBySize(
  repoDir: string,
  relativePaths: readonly string[],
): { toAdd: string[]; skippedOversized: string[] } {
  const toAdd: string[] = [];
  const skippedOversized: string[] = [];

  for (const rel of relativePaths) {
    const full = path.join(repoDir, rel);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) {
        continue;
      }
      if (isTooLargeForGitSync(stat.size)) {
        skippedOversized.push(rel);
        continue;
      }
      toAdd.push(rel);
    } catch {
      /* removed between ls-files and stat */
    }
  }

  return { toAdd, skippedOversized };
}

/**
 * Stage sync scopes using git discovery + size cap + dist force-add.
 */
export async function stageGitSyncScopes(
  runGit: RunGitFn,
  repoDir: string,
  scopes: readonly string[],
  forceMiniAppDistForAppIds: readonly string[] = [],
): Promise<{ skippedOversized: string[] }> {
  const skippedOversized: string[] = [];

  for (const scope of uniqueScopes(scopes)) {
    await stageScopeUpdates(runGit, scope);

    const untracked = await listUntrackedNonIgnoredFiles(runGit, scope);
    const { toAdd, skippedOversized: skipped } = partitionUntrackedBySize(
      repoDir,
      untracked,
    );
    skippedOversized.push(...skipped);

    for (let i = 0; i < toAdd.length; i += ADD_CHUNK_SIZE) {
      const chunk = toAdd.slice(i, i + ADD_CHUNK_SIZE);
      if (chunk.length > 0) {
        await runGit(["add", "--", ...chunk]);
      }
    }
  }

  const distPaths = miniAppDistRelativePaths(repoDir, forceMiniAppDistForAppIds);
  if (distPaths.length > 0) {
    await runGit(["add", "-f", "--", ...distPaths]);
  }

  return { skippedOversized };
}
