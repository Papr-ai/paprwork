/**
 * Repository hygiene guards for CloudSync.
 *
 * Background — the bug this fixes
 * ────────────────────────────────
 * A user's sync repo grew to 253 GB. Root causes, in order of impact:
 *
 *  1. **Orphaned repack temp files.** 18 `tmp_pack_*` files totalling 207 GB
 *     sat in the pack directory. Git writes these while repacking and unlinks
 *     them on success — but CloudSync's git calls are killed on timeout
 *     (`SIGTERM` in gitRunner), which strands multi-GB temp packs forever.
 *     Nothing ever cleaned them up because CloudSync never ran `gc`.
 *
 *  2. **SQLite + `.bak` blobs in history.** 47 `*.db*` and 78 `*.bak` files
 *     were tracked. SQLite files are dense binaries git cannot delta-compress,
 *     so every sync commit stored a "fresh full copy" (~50 GB of real packs).
 *     `.gitignore` gained a SQLite rule later, but gitignore never untracks —
 *     already-tracked paths keep being committed forever.
 *
 *  3. **No size ceiling.** Nothing measured the repo, warned, or stopped.
 *
 * Staging now uses git-native discovery (see gitStageScope.ts). This module
 * handles repo size measurement, temp-pack cleanup, and untracking legacy blobs.
 */

import fs from "node:fs";
import path from "node:path";
import { MAX_GIT_SYNC_FILE_BYTES } from "./gitSyncLimits.js";

/**
 * Paths that must never enter git. SQLite replicates via Turso; backups are
 * local disaster-recovery artifacts; venvs/logs are per-machine runtime state.
 *
 * Used by repo maintenance (`git rm --cached`) to untrack legacy blobs already
 * in history — not for staging (gitignore + git ls-files handle that).
 */
export const NEVER_TRACK_PATHSPECS = [
  "*.db",
  "*.db-wal",
  "*.db-shm",
  "*.sqlite",
  "*.sqlite3",
  "*.bak",
  "*.bak.*",
  "backups/",
  "**/backups/",
  "*.tgz",
  "*.tar.gz",
  "*.zip",
  "*.wav",
  "*.mp4",
  "*.mov",
  "*.m4a",
  "*.mp3",
  "*.aiff",
  "*.caf",
  "*.flac",
  "*.webm",
] as const;

/** Reject any single blob larger than this at stage time (matches gitSyncLimits). */
export const MAX_TRACKED_FILE_BYTES = MAX_GIT_SYNC_FILE_BYTES;

/** Warn the user in Settings → Sync above this repo size. */
export const REPO_SIZE_WARN_BYTES = 5 * 1024 * 1024 * 1024;

/** Refuse to add new content above this repo size; sync keeps pulling but stops pushing growth. */
export const REPO_SIZE_CRITICAL_BYTES = 20 * 1024 * 1024 * 1024;

/** Temp packs older than this are certainly orphaned (no git process survives it). */
export const STALE_TMP_PACK_AGE_MS = 60 * 60 * 1000;

/** Run full hygiene at most this often. */
export const HYGIENE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface TmpPackSweepResult {
  removedFiles: number;
  reclaimedBytes: number;
}

export interface RepoSizeInfo {
  gitDirBytes: number;
  level: "ok" | "warn" | "critical";
}

/**
 * Delete orphaned `tmp_pack_*` / `.tmp-*` files left behind by killed repacks.
 *
 * Safe because git only keeps these open during an active repack: we skip any
 * file younger than STALE_TMP_PACK_AGE_MS, and callers must confirm no git
 * process is running for this repo.
 */
export function sweepStaleTmpPacks(
  repoDir: string,
  now = Date.now(),
): TmpPackSweepResult {
  const packDir = path.join(repoDir, ".git", "objects", "pack");
  const result: TmpPackSweepResult = { removedFiles: 0, reclaimedBytes: 0 };
  if (!fs.existsSync(packDir)) return result;

  let entries: string[];
  try {
    entries = fs.readdirSync(packDir);
  } catch {
    return result;
  }

  for (const name of entries) {
    if (!name.startsWith("tmp_pack_") && !name.startsWith(".tmp-")) continue;
    const full = path.join(packDir, name);
    try {
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs < STALE_TMP_PACK_AGE_MS) continue;
      fs.unlinkSync(full);
      result.removedFiles += 1;
      result.reclaimedBytes += stat.size;
    } catch {
      /* raced with git or permission issue — skip */
    }
  }
  return result;
}

/** Recursive byte size of `.git`, capped in depth to stay cheap. */
export function measureGitDirBytes(repoDir: string): number {
  const gitDir = path.join(repoDir, ".git");
  let total = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* transient */
        }
      }
    }
  };
  walk(gitDir, 0);
  return total;
}

export function classifyRepoSize(gitDirBytes: number): RepoSizeInfo {
  const level =
    gitDirBytes >= REPO_SIZE_CRITICAL_BYTES
      ? "critical"
      : gitDirBytes >= REPO_SIZE_WARN_BYTES
        ? "warn"
        : "ok";
  return { gitDirBytes, level };
}
