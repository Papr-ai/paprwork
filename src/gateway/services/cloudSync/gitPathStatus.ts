/**
 * Helpers for deciding whether a Papr folder is already reflected in git
 * (working tree clean + tracked files) even when sync state was never marked.
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/** Subdirs under apps/ or Jobs/ that have at least one tracked file in git. */
export function loadGitTrackedSubdirPaths(paprDir: string): Set<string> {
  const tracked = new Set<string>();
  if (!fs.existsSync(path.join(paprDir, ".git"))) {
    return tracked;
  }
  try {
    const output = execSync("git ls-files apps/ Jobs/", {
      cwd: paprDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const filePath of output.split("\n")) {
      if (!filePath) continue;
      const normalized = filePath.replace(/\\/g, "/");
      const parts = normalized.split("/");
      if (
        (parts[0] === "apps" || parts[0] === "Jobs") &&
        parts[1] &&
        !parts[1].startsWith(".")
      ) {
        tracked.add(`${parts[0]}/${parts[1]}`);
      }
    }
  } catch {
    /* git unavailable or not a repo */
  }
  return tracked;
}

export function canReconcilePathAsSynced(opts: {
  exists: boolean;
  porcelain: string;
  trackedFiles: string;
}): boolean {
  if (!opts.exists) {
    return false;
  }
  if (opts.porcelain.trim().length > 0) {
    return false;
  }
  return opts.trackedFiles.trim().length > 0;
}
