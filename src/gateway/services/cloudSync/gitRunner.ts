/**
 * Non-blocking git execution for CloudSync.
 *
 * Uses child_process.spawn (not execSync) so long git add/commit/push operations
 * never block the Gateway event loop — health checks and WebSocket stay responsive.
 *
 * Operations are serialized through a promise chain because git index.lock is
 * not safe under concurrent commands on the same repo.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { ephemeralGitEnv } from "../../utils/ephemeralGitEnv.js";

export interface RunGitOptions {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

export class GitCommandError extends Error {
  readonly args: string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(args: string[], exitCode: number | null, stderr: string) {
    const detail = stderr.trim() || `exit code ${exitCode ?? "unknown"}`;
    super(`git ${args.join(" ")} failed: ${detail}`);
    this.name = "GitCommandError";
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export async function probeGitInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("git", ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function runGitOnce(args: string[], opts: RunGitOptions = {}): Promise<string> {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const cwd = opts.cwd;

  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: ephemeralGitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killedForSize = false;

    const onData = (
      chunk: Buffer,
      target: "stdout" | "stderr",
    ): void => {
      const text = chunk.toString();
      if (target === "stdout") {
        stdout += text;
        if (stdout.length > maxBuffer) killedForSize = true;
      } else {
        stderr += text;
        if (stderr.length > maxBuffer) killedForSize = true;
      }
      if (killedForSize) {
        child.kill("SIGTERM");
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => onData(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => onData(chunk, "stderr"));

    const timer = setTimeout(() => {
      // SIGTERM lets git unlink its temp packs; SIGKILL strands them. A killed
      // `repack` previously left 18 orphaned tmp_pack_* files totalling 207 GB
      // in one user's repo, so we give git a grace period to clean up itself
      // and only escalate if it ignores the term.
      child.kill("SIGTERM");
      const escalate = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }, 10_000);
      child.once("close", () => clearTimeout(escalate));
      reject(
        new Error(
          `git ${args.join(" ")} timed out after ${timeout}ms`,
        ),
      );
    }, timeout);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killedForSize) {
        reject(
          new Error(
            `git ${args.join(" ")} exceeded ${maxBuffer} byte output limit`,
          ),
        );
        return;
      }
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new GitCommandError(args, code, stderr));
    });
  });
}

export class GitRunner {
  private chain: Promise<unknown> = Promise.resolve();

  /** Run git with args; serialized with other CloudSync git operations. */
  run(args: string[], opts?: RunGitOptions): Promise<string> {
    const run = this.chain.then(
      () => runGitOnce(args, opts),
      () => runGitOnce(args, opts),
    );
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  clone(cloneUrl: string, destDir: string, timeout = 120_000): Promise<void> {
    return this.run(["clone", "--depth", "1", cloneUrl, destDir], { timeout }).then(
      () => undefined,
    );
  }

  async isRepo(cwd: string): Promise<boolean> {
    try {
      await this.run(["rev-parse", "--git-dir"], { cwd, timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  /** True when `.git` lives directly under `cwd` (not a parent directory). */
  async isRepoAtRoot(cwd: string): Promise<boolean> {
    try {
      const gitDir = (await this.run(["rev-parse", "--git-dir"], { cwd, timeout: 5_000 })).trim();
      const resolvedGitDir = path.resolve(cwd, gitDir);
      const expectedGitDir = path.resolve(cwd, ".git");
      return resolvedGitDir === expectedGitDir;
    } catch {
      return false;
    }
  }
}
