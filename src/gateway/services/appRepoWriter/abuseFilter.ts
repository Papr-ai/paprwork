/**
 * Reject abusive file ops before they reach git (writer door).
 */

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

/**
 * Match a repo path against the never-track pathspecs.
 *
 * Extension specs are anchored to the end of the basename. Matching them as a
 * bare substring instead — which this did — silently dropped ordinary source
 * files from sync: `*.db` matched `sandbox.ts`, `*.mov` matched `remove.ts`,
 * and `*.zip` matched `zipcode.ts`.
 */
export function isNeverTrackRepoPath(repoPath: string): boolean {
  const normalized = normalizeRepoPath(repoPath).toLowerCase();
  const segments = normalized.split("/");
  const base = segments[segments.length - 1] ?? "";
  const dirSegments = segments.slice(0, -1);

  for (const spec of NEVER_TRACK_PATHSPECS) {
    const lower = spec.toLowerCase();

    if (lower.endsWith("/")) {
      const dirName = lower.replace(/^\*\*\//, "").slice(0, -1);
      if (dirSegments.includes(dirName)) {
        return true;
      }
      continue;
    }

    if (lower.startsWith("*.")) {
      const suffix = lower.slice(1);
      // "*.bak.*" — an infix such as `db.bak.2026-01-01`.
      if (suffix.endsWith(".*")) {
        if (base.includes(suffix.slice(0, -1))) {
          return true;
        }
        continue;
      }
      if (base.endsWith(suffix)) {
        return true;
      }
      continue;
    }

    if (base === lower) {
      return true;
    }
  }

  return base.startsWith("tmp_pack_");
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

  if (isNeverTrackRepoPath(repoPath)) {
    return { path: repoPath, reason: "path blocked by repo hygiene rules" };
  }

  if (input.content !== null) {
    const bytes = input.byteLength ?? Buffer.byteLength(input.content, "utf8");
    if (bytes > MAX_TRACKED_FILE_BYTES) {
      return {
        path: repoPath,
        reason: `file exceeds ${MAX_TRACKED_FILE_BYTES} byte limit`,
      };
    }
  }

  return null;
}

export function filterAbusiveOpFiles<
  T extends { path: string; content: string | null },
>(files: readonly T[]): { accepted: T[]; rejected: AbuseRejection[] } {
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
