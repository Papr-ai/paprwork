/**
 * Git Auto-Staging Utility
 * 
 * Automatically stages files after Paprwork agent edits to prevent data loss
 * during branch switches or git operations.
 * 
 * Problem: When agent writes files, they're not tracked by git. If user runs:
 * - git checkout <branch>
 * - git clean -fd
 * - git reset --hard
 * Then untracked files are lost.
 * 
 * Solution: Auto-stage files after write operations so they're tracked.
 */

import { execSync } from "child_process";
import path from "path";
import fs from "fs/promises";

interface GitAutoStageResult {
  staged: boolean;
  gitRepo: boolean;
  path: string;
  error?: string;
}

/**
 * Check if a path is inside a git repository
 */
async function isInGitRepo(filePath: string): Promise<boolean> {
  try {
    const dir = path.dirname(filePath);
    execSync("git rev-parse --git-dir", {
      cwd: dir,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if file is in .gitignore
 */
function isIgnored(filePath: string): boolean {
  try {
    const dir = path.dirname(filePath);
    const output = execSync(`git check-ignore "${filePath}"`, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return output.trim().length > 0;
  } catch {
    // If command fails, file is NOT ignored
    return false;
  }
}

/**
 * Stage a file in git after agent modification
 * 
 * @param filePath - Absolute path to file that was modified
 * @returns Result indicating whether file was staged
 */
export async function autoStageFile(
  filePath: string,
): Promise<GitAutoStageResult> {
  try {
    // 1. Check if file exists
    try {
      await fs.access(filePath);
    } catch {
      return {
        staged: false,
        gitRepo: false,
        path: filePath,
        error: "File does not exist",
      };
    }

    // 2. Check if we're in a git repo
    const inGitRepo = await isInGitRepo(filePath);
    if (!inGitRepo) {
      return {
        staged: false,
        gitRepo: false,
        path: filePath,
      };
    }

    // 3. Check if file is gitignored
    if (isIgnored(filePath)) {
      return {
        staged: false,
        gitRepo: true,
        path: filePath,
        error: "File is in .gitignore",
      };
    }

    // 4. Stage the file
    const dir = path.dirname(filePath);
    execSync(`git add "${filePath}"`, {
      cwd: dir,
      stdio: "ignore",
    });

    return {
      staged: true,
      gitRepo: true,
      path: filePath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      staged: false,
      gitRepo: true,
      path: filePath,
      error: `Git add failed: ${message}`,
    };
  }
}

/**
 * Get git status for a file
 * 
 * @param filePath - Path to check
 * @returns Status string (e.g., "M" for modified, "A" for added, "??" for untracked)
 */
export function getGitStatus(filePath: string): string | null {
  try {
    const dir = path.dirname(filePath);
    const output = execSync(`git status --porcelain "${filePath}"`, {
      cwd: dir,
      encoding: "utf8",
    });
    return output.trim().substring(0, 2); // First 2 chars are status
  } catch {
    return null;
  }
}
