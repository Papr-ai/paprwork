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
 * Design principles
 * ─────────────────
 * - **Non-destructive by default.** We only delete things git itself would
 *   delete (stale temp packs), and we only *untrack* — never delete from disk.
 * - **Bounded work.** Hygiene is throttled and runs `gc` in background-safe
 *   increments so it can't wedge the sync loop.
 * - **Observable.** Every action returns a structured result for logging and
 *   for surfacing repo size in Settings → Sync.
 */

import fs from "node:fs";
import path from "node:path";
import {
  isLocalOnlyCloudSyncArtifact,
  MAX_GIT_SYNC_FILE_BYTES,
} from "./gitSyncLimits.js";

/**
 * Paths that must never enter git. SQLite replicates via Turso; backups are
 * local disaster-recovery artifacts; venvs/logs are per-machine runtime state.
 *
 * Kept as pathspecs so they can be passed straight to `git rm --cached`.
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

/**
 * Directory names that never belong in git, matched at any depth.
 *
 * `recordings` is here because the Meeting mini-app writes multi-GB `.wav`
 * captures to `Jobs/<id>/data/recordings/`. Extension rules alone are fragile:
 * a future encoder change (`.m4a`, `.opus`) would silently start committing
 * again. Blocking the directory makes the guarantee format-independent.
 */
export const NEVER_TRACK_DIR_SEGMENTS = ["backups", "recordings"] as const;

/**
 * Safety valve for directory expansion — a single staged directory should
 * never fan out past this many files. Beyond it we refuse the whole directory
 * rather than stage a partially-filtered subtree.
 */
export const MAX_DIR_EXPANSION_ENTRIES = 5000;

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

/**
 * Filter stage paths, dropping anything oversized or matching a never-track rule.
 *
 * This is the belt-and-braces companion to `.gitignore`: gitignore is advisory
 * and silently bypassed by explicit `git add -- <path>`, which is exactly what
 * CloudSync does. This filter runs on the actual pathspec list.
 */
export function partitionStagePaths(
  repoDir: string,
  candidatePaths: string[],
): { allowed: string[]; rejected: Array<{ path: string; reason: string }> } {
  const allowed: string[] = [];
  const rejected: Array<{ path: string; reason: string }> = [];

  for (const rel of candidatePaths) {
    if (matchesNeverTrack(rel)) {
      rejected.push({ path: rel, reason: "never-track pattern" });
      continue;
    }
    const full = path.join(repoDir, rel);
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(full);
    } catch {
      /* deleted paths still need staging so the removal is committed */
      allowed.push(rel);
      continue;
    }

    if (stat.isDirectory()) {
      // A directory pathspec makes `git add` recurse, which bypasses every
      // per-file check below — this is how multi-GB recordings reached git
      // despite the size ceiling. Expand to files and vet each one.
      const expansion = expandDirectory(repoDir, rel);
      if (expansion.truncated) {
        rejected.push({
          path: rel,
          reason: `directory exceeds ${MAX_DIR_EXPANSION_ENTRIES} files; refusing bulk stage`,
        });
        continue;
      }
      const inner = partitionStagePaths(repoDir, expansion.files);
      allowed.push(...inner.allowed);
      rejected.push(...inner.rejected);
      continue;
    }

    if (stat.isFile() && stat.size > MAX_TRACKED_FILE_BYTES) {
      rejected.push({
        path: rel,
        reason: `file ${(stat.size / 1048576).toFixed(1)} MB exceeds ${MAX_TRACKED_FILE_BYTES / 1048576} MB limit`,
      });
      continue;
    }
    allowed.push(rel);
  }
  return { allowed, rejected };
}

/**
 * List files under a repo-relative directory, skipping never-track subtrees.
 *
 * Pruning during the walk (rather than filtering after) keeps us from
 * enumerating a 90-file / 68 GB recordings directory just to discard it.
 */
export function expandDirectory(
  repoDir: string,
  relDir: string,
): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  const stack: string[] = [relDir];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(repoDir, current), {
        withFileTypes: true,
      });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const rel = path.posix.join(current.replace(/\\/g, "/"), entry.name);
      if (matchesNeverTrack(rel)) continue;
      if (entry.isDirectory()) {
        stack.push(rel);
      } else if (entry.isFile()) {
        if (files.length >= MAX_DIR_EXPANSION_ENTRIES) {
          return { files, truncated: true };
        }
        files.push(rel);
      }
    }
  }
  return { files, truncated: false };
}

/** True when a repo-relative path matches any never-track rule. */
export function matchesNeverTrack(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  const base = path.posix.basename(normalized);
  const segments = normalized.split("/");

  if (isLocalOnlyCloudSyncArtifact(base)) {
    return true;
  }

  if (NEVER_TRACK_DIR_SEGMENTS.some((seg) => segments.includes(seg))) {
    return true;
  }

  return NEVER_TRACK_PATHSPECS.some((pattern) => {
    if (pattern.endsWith("/")) return false; // handled by segment check above
    const clean = pattern.replace(/^\*\*\//, "");
    if (clean.startsWith("*.")) {
      const ext = clean.slice(1); // ".db"
      if (clean.endsWith(".*")) {
        // "*.bak.*" → any ".bak." infix
        const infix = clean.slice(1, -2);
        return base.includes(`${infix}.`);
      }
      return base.endsWith(ext);
    }
    return base === clean;
  });
}
