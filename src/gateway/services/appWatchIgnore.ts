/**
 * Chokidar ignore predicate for mini-app directory watchers.
 *
 * String glob patterns do not match absolute paths reliably — use this function
 * for `ignored` instead.
 */

import path from "path";
import { isCloudPrepGitSyncArtifact } from "./cloudSync/syncState.js";

const METADATA_FILENAMES = new Set([
  "data-sources.json",
  "linked-databases.json",
]);

/** Directory segments we never need hot-reload or Sync V3 debounce on. */
const IGNORED_DIR_SEGMENTS = [
  "/node_modules/",
  "/.venv/",
  "/venv/",
  "/data/",
  "/build/",
  "/__pycache__/",
  "/.git/",
] as const;

export function shouldIgnoreAppWatchPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const base = path.basename(filePath);

  if (isCloudPrepGitSyncArtifact(normalized)) {
    return true;
  }

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

  for (const segment of IGNORED_DIR_SEGMENTS) {
    if (normalized.includes(segment)) {
      return true;
    }
  }

  return false;
}
