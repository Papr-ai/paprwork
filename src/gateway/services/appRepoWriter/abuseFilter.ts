/**
 * Reject abusive file ops before they reach git (writer door).
 */

import * as path from "node:path";

import {
  MAX_TRACKED_FILE_BYTES,
  NEVER_TRACK_PATHSPECS,
} from "../cloudSync/repoHygiene.js";

export interface AbuseRejection {
  path: string;
  reason: string;
}

function normalizeRepoPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function matchesNeverTrackPathspec(repoPath: string): boolean {
  const normalized = normalizeRepoPath(repoPath);
  const base = path.posix.basename(normalized).toLowerCase();

  for (const spec of NEVER_TRACK_PATHSPECS) {
    const trimmed = spec.replace(/^\*\./, "");
    if (spec.startsWith("**/")) {
      if (normalized.includes(spec.slice(3))) {
        return true;
      }
      continue;
    }
    if (spec.endsWith("/")) {
      if (normalized.startsWith(spec) || normalized.includes(`/${spec}`)) {
        return true;
      }
      continue;
    }
    if (spec.startsWith("*.")) {
      if (base.endsWith(trimmed) || base.includes(trimmed)) {
        return true;
      }
    }
  }

  if (base.startsWith("tmp_pack_")) {
    return true;
  }

  return false;
}

export function validateOpFileForWriter(input: {
  path: string;
  content: string | null;
  byteLength?: number;
}): AbuseRejection | null {
  const repoPath = normalizeRepoPath(input.path);
  if (!repoPath || repoPath.includes("..")) {
    return { path: input.path, reason: "invalid path" };
  }

  if (matchesNeverTrackPathspec(repoPath)) {
    return { path: repoPath, reason: "path blocked by repo hygiene rules" };
  }

  if (input.content !== null) {
    const bytes =
      input.byteLength ?? Buffer.byteLength(input.content, "utf8");
    if (bytes > MAX_TRACKED_FILE_BYTES) {
      return {
        path: repoPath,
        reason: `file exceeds ${MAX_TRACKED_FILE_BYTES} byte limit`,
      };
    }
  }

  return null;
}

export function filterAbusiveOpFiles<T extends { path: string; content: string | null }>(
  files: readonly T[],
): { accepted: T[]; rejected: AbuseRejection[] } {
  const accepted: T[] = [];
  const rejected: AbuseRejection[] = [];
  for (const file of files) {
    const rejection = validateOpFileForWriter(file);
    if (rejection) {
      rejected.push(rejection);
    } else {
      accepted.push(file);
    }
  }
  return { accepted, rejected };
}
