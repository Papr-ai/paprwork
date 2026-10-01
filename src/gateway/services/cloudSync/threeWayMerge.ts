/**
 * Line-level three-way merge + base-commit reads for collaborator copies.
 *
 * A collaborator's copy and the publisher's main both move after install.
 * Comparing whole-file hashes calls every file both sides touched a conflict
 * and, worse, treats a stale local file as "the collaborator's version". Git
 * already knows how to do this: merge each file against the commit both
 * sides started from.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { hashBlobContent } from "../syncV3/computeParentHash.js";

export interface GitRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Exit codes treated as success (git merge-file exits 1..127 on conflicts). */
  okCodes?: number[];
}

export interface GitRunResult {
  stdout: string;
  code: number;
}

export function runGit(args: string[], opts: GitRunOptions = {}): Promise<GitRunResult> {
  const okCodes = opts.okCodes ?? [0];
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`git ${args[0]} timed out`));
    }, opts.timeoutMs ?? 120_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const exit = code ?? -1;
      if (okCodes.includes(exit)) {
        resolve({ stdout, code: exit });
        return;
      }
      const safe = stderr.replace(/https:\/\/x-access-token:[^@\s]+@/gi, "https://***@");
      reject(new Error(`git ${args[0]} failed (${exit}): ${safe.trim().slice(0, 300)}`));
    });
  });
}

export interface ThreeWayMergeResult {
  clean: boolean;
  /** Merged text when clean; undefined on conflict (caller keeps local). */
  content?: string;
}

/**
 * Merge `local` and `upstream` against their common `base`, line by line.
 * Edits in different places combine; overlapping edits are a conflict.
 */
export async function mergeFileContents(
  local: string,
  base: string,
  upstream: string,
): Promise<ThreeWayMergeResult> {
  if (local === upstream) return { clean: true, content: local };
  if (local === base) return { clean: true, content: upstream };
  if (upstream === base) return { clean: true, content: local };

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "papr-merge-"));
  try {
    const localPath = path.join(dir, "local");
    const basePath = path.join(dir, "base");
    const upstreamPath = path.join(dir, "upstream");
    await Promise.all([
      fs.writeFile(localPath, local, "utf8"),
      fs.writeFile(basePath, base, "utf8"),
      fs.writeFile(upstreamPath, upstream, "utf8"),
    ]);
    // Exit 0 = clean; 1..127 = number of conflict hunks; >127 = error.
    const okCodes = Array.from({ length: 128 }, (_, i) => i);
    const result = await runGit(
      ["merge-file", "-p", "--diff3", localPath, basePath, upstreamPath],
      { okCodes },
    );
    if (result.code === 0) return { clean: true, content: result.stdout };
    return { clean: false };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** HEAD commit of a cloned repo, or null. */
export async function readHeadCommit(
  repoDir: string,
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  try {
    const { stdout } = await runGit(["rev-parse", "HEAD"], { cwd: repoDir, env });
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Make `sha` available locally (shallow/partial clones only have HEAD).
 * Returns false when the commit can't be fetched (force-pushed away, etc.).
 */
export async function ensureCommitAvailable(
  repoDir: string,
  sha: string,
  env?: NodeJS.ProcessEnv,
): Promise<boolean> {
  const has = async () => {
    try {
      await runGit(["cat-file", "-e", `${sha}^{commit}`], { cwd: repoDir, env });
      return true;
    } catch {
      return false;
    }
  };
  if (await has()) return true;
  try {
    await runGit(
      ["fetch", "--depth", "1", "--filter=blob:none", "origin", sha],
      { cwd: repoDir, env, timeoutMs: 120_000 },
    );
  } catch {
    return false;
  }
  return has();
}

/**
 * Text files under `prefix` at `sha`, keyed relative to `prefix`.
 * `prefix` "." / "" means the repo root.
 *
 * `known`: local content by the same keys. A file whose git blob id matches
 * the local content is taken from `known` instead of downloaded — on a
 * partial clone most files are unchanged, so this skips most fetches.
 */
export async function readFilesAtCommit(
  repoDir: string,
  sha: string,
  prefix: string,
  env?: NodeJS.ProcessEnv,
  known?: Map<string, string>,
): Promise<Map<string, string>> {
  const root = prefix === "." ? "" : prefix.replace(/\\/g, "/").replace(/\/+$/, "");
  const files = new Map<string, string>();
  let listing: string;
  try {
    listing = (
      await runGit(["ls-tree", "-r", sha, ...(root ? ["--", root] : [])], { cwd: repoDir, env })
    ).stdout;
  } catch {
    return files;
  }
  for (const line of listing.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const [, type, oid] = line.slice(0, tab).split(" ");
    if (type !== "blob") continue;
    const repoPath = line.slice(tab + 1);
    if (root && !repoPath.startsWith(`${root}/`)) continue;
    const rel = root ? repoPath.slice(root.length + 1) : repoPath;
    const local = known?.get(rel);
    if (local !== undefined && hashBlobContent(local) === oid) {
      files.set(rel, local);
      continue;
    }
    try {
      const { stdout: content } = await runGit(["cat-file", "blob", oid], { cwd: repoDir, env });
      files.set(rel, content);
    } catch {
      /* unreadable — skip */
    }
  }
  return files;
}

/** Shallow clones (install/track use --depth 1) need history to find a base. */
async function ensureHistory(repoDir: string, env?: NodeJS.ProcessEnv): Promise<void> {
  try {
    const { stdout } = await runGit(["rev-parse", "--is-shallow-repository"], { cwd: repoDir, env });
    if (stdout.trim() !== "true") return;
    await runGit(["fetch", "--unshallow", "--filter=blob:none", "origin"], {
      cwd: repoDir,
      env,
      timeoutMs: 180_000,
    });
  } catch {
    /* best effort — inference just sees less history */
  }
}

/**
 * Older copies never recorded the commit they started from. Infer it from the
 * files themselves: a file the collaborator didn't edit is byte-identical to
 * the publisher's version at that commit. The newest commit matching the most
 * local files is the base. Compares git blob ids only — no file downloads.
 *
 * `localOids`: repo-relative path → git blob id of the local content (already
 * remapped to the publisher's ids). Installer-rewritten files should be left
 * out by the caller; they match no commit and only add noise.
 */
export async function inferBaseCommitFromLocal(
  repoDir: string,
  localOids: Map<string, string>,
  env?: NodeJS.ProcessEnv,
  maxCommits = 80,
): Promise<string | null> {
  if (localOids.size === 0) return null;
  await ensureHistory(repoDir, env);
  let commits: string[];
  try {
    const { stdout } = await runGit(["rev-list", `--max-count=${maxCommits}`, "HEAD"], {
      cwd: repoDir,
      env,
    });
    commits = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
  let best: { sha: string; score: number } | null = null;
  for (const sha of commits) {
    let tree: string;
    try {
      tree = (await runGit(["ls-tree", "-r", sha], { cwd: repoDir, env })).stdout;
    } catch {
      continue;
    }
    let score = 0;
    for (const line of tree.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const repoPath = line.slice(tab + 1);
      const want = localOids.get(repoPath);
      if (!want) continue;
      const oid = line.slice(0, tab).split(" ")[2];
      if (oid === want) score += 1;
    }
    // Newest-first: only a strictly better score moves the base back in time.
    if (!best || score > best.score) best = { sha, score };
    if (score === localOids.size) break;
  }
  return best && best.score > 0 ? best.sha : null;
}

/**
 * The commit to merge/branch against: the recorded one if it can be fetched,
 * otherwise inferred from local files. Null when neither works.
 */
export async function resolveBaseCommit(
  repoDir: string,
  recorded: string | undefined,
  localOids: () => Promise<Map<string, string>>,
  env?: NodeJS.ProcessEnv,
): Promise<{ sha: string; inferred: boolean } | null> {
  if (recorded && (await ensureCommitAvailable(repoDir, recorded, env))) {
    return { sha: recorded, inferred: false };
  }
  const inferred = await inferBaseCommitFromLocal(repoDir, await localOids(), env);
  return inferred ? { sha: inferred, inferred: true } : null;
}

/**
 * Would merging `head` into `target` conflict? Uses `git merge-tree
 * --write-tree` (git ≥ 2.38). Returns conflicted paths, [] when clean, or null
 * when the check isn't available.
 */
export async function previewMergeConflicts(
  repoDir: string,
  target: string,
  head: string,
  env?: NodeJS.ProcessEnv,
): Promise<string[] | null> {
  try {
    const { stdout, code } = await runGit(
      ["merge-tree", "--write-tree", "--name-only", "--no-messages", target, head],
      { cwd: repoDir, env, okCodes: [0, 1] },
    );
    if (code === 0) return [];
    // Output: <tree oid>\n<conflicted path>...
    return stdout.split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
}
