/**
 * parentHash verification against HEAD tree (Sync V3 writer).
 */

import type { AppRepoOpFile } from "../../../core/types/appRepoWriterOps.js";
import type { RunGitFn } from "../cloudSync/gitStageScope.js";

export interface ParentHashMismatch {
  path: string;
  expectedParentHash: string;
  actualBlobOid: string | null;
}

async function blobOidAtHead(
  runGit: RunGitFn,
  repoPath: string,
): Promise<string | null> {
  try {
    const oid = await runGit(["rev-parse", `HEAD:${repoPath}`]);
    const trimmed = oid.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export async function verifyParentHashes(
  runGit: RunGitFn,
  files: readonly AppRepoOpFile[],
): Promise<ParentHashMismatch[]> {
  const mismatches: ParentHashMismatch[] = [];

  for (const file of files) {
    const actual = await blobOidAtHead(runGit, file.path);
    const expected = file.parentHash.trim();

    if (expected.length === 0) {
      if (actual !== null) {
        mismatches.push({
          path: file.path,
          expectedParentHash: "",
          actualBlobOid: actual,
        });
      }
      continue;
    }

    if (actual !== expected) {
      mismatches.push({
        path: file.path,
        expectedParentHash: expected,
        actualBlobOid: actual,
      });
    }
  }

  return mismatches;
}

export async function listHeadFileOids(
  runGit: RunGitFn,
): Promise<Array<{ path: string; blobOid: string }>> {
  try {
    const listed = await runGit(["ls-tree", "-r", "--full-name", "-z", "HEAD"]);
    const entries = listed.split("\0").filter(Boolean);
    const files: Array<{ path: string; blobOid: string }> = [];
    for (const entry of entries) {
      const match = /^(\d+) (blob|tree) ([0-9a-f]{40})\t(.+)$/.exec(entry);
      if (!match || match[2] !== "blob") {
        continue;
      }
      files.push({ path: match[4], blobOid: match[3] });
    }
    return files;
  } catch {
    return [];
  }
}
