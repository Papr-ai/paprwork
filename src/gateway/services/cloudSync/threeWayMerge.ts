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
 */
export async function readFilesAtCommit(
  repoDir: string,
  sha: string,
  prefix: string,
  env?: NodeJS.ProcessEnv,
): Promise<Map<string, string>> {
  const root = prefix === "." ? "" : prefix.replace(/\\/g, "/").replace(/\/+$/, "");
  const files = new Map<string, string>();
  const { stdout } = await runGit(
    ["ls-tree", "-r", "--name-only", sha, ...(root ? ["--", root] : [])],
    { cwd: repoDir, env },
  );
  for (const repoPath of stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const rel = root ? repoPath.slice(root.length + 1) : repoPath;
    try {
      const { stdout: content } = await runGit(["show", `${sha}:${repoPath}`], {
        cwd: repoDir,
        env,
      });
      files.set(rel, content);
    } catch {
      /* binary / unreadable — skip */
    }
  }
  return files;
}
