/**
 * Chokidar ignore predicate for mini-app directory watchers.
 *
 * String glob patterns do not match absolute paths reliably — use this function
 * for `ignored` instead.
 */

import path from "path";

const METADATA_FILENAMES = new Set([
  "data-sources.json",
  "linked-databases.json",
]);

export function shouldIgnoreAppWatchPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const base = path.basename(filePath);

  if (base.startsWith(".")) {
    return true;
  }

  if (METADATA_FILENAMES.has(base)) {
    return true;
  }

  if (
    normalized.includes("/.versions/") ||
    normalized.includes("/dist/") ||
    normalized.includes("/.dist-staging/")
  ) {
    return true;
  }

  return false;
}
