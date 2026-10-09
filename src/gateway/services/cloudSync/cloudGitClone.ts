/**
 * Clone published app source from owner GitHub repo (install / track sync).
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ephemeralGitEnv } from "../../utils/ephemeralGitEnv.js";

export interface CloudGitCloneInput {
  cloneUrl: string;
  token: string;
  repoPath: string;
  /** Check out this commit instead of HEAD (the publisher's last finished publish). */
  commit?: string | null;
}

export interface CloudGitCloneResult {
  sourceDir: string;
  repoDir: string;
  cleanup: () => Promise<void>;
}

function authCloneUrl(cloneUrl: string, token: string): string {
  const normalized = cloneUrl.replace(/^https:\/\//, "");
  return `https://x-access-token:${token}@${normalized}`;
}

/** Strip embedded git credentials from clone error output before logging. */
export function redactGitCloneErrorMessage(message: string): string {
  return message
    .replace(/https:\/\/x-access-token:[^@\s]+@/gi, "https://***@")
    .replace(/ghs_[A-Za-z0-9_]+/g, "ghs_***");
}

/** True when git clone failed because the remote repo does not exist or is inaccessible. */
export function isGitRepositoryNotFoundError(error: unknown): boolean {
  const message = redactGitCloneErrorMessage(
    error instanceof Error ? error.message : String(error),
  ).toLowerCase();
  return (
    message.includes("repository not found") ||
    message.includes("remote: not found") ||
    (message.includes("failed (128)") && message.includes("not found"))
  );
}

/** Sync V3 per-app repos use repo root; legacy namespace repos use apps/{appId}/. */
export function isAppRepoRootPath(repoPath: string): boolean {
  const normalized = repoPath.replace(/\\/g, "/").trim();
  return normalized === "" || normalized === ".";
}

async function runCommand(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<void> {
  const { spawn } = await import("node:child_process");
  const timeoutMs = opts.timeoutMs ?? 120_000;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const safeArgs = args.map((arg) =>
        arg.replace(/https:\/\/x-access-token:[^@]+@/gi, "https://***@"),
      );
      reject(
        new Error(
          `${command} ${safeArgs.join(" ")} failed (${code ?? "unknown"}): ${redactGitCloneErrorMessage(stderr.trim())}`,
        ),
      );
    });
  });
}

/**
 * Move a fresh clone to the published commit. HEAD can be mid-upload (code
 * pushed, database not yet); the completed commit is what the publisher
 * verified. If the commit can't be fetched we keep HEAD and say so — an
 * install must not fail just because the record is ahead of the repo.
 */
export async function checkoutPublishedCommit(
  repoDir: string,
  commit: string | null | undefined,
  env: NodeJS.ProcessEnv,
  shallow: boolean,
): Promise<void> {
  const sha = commit?.trim();
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) return;
  try {
    if (shallow) {
      await runCommand("git", ["fetch", "--depth", "1", "--filter=blob:none", "origin", sha], {
        cwd: repoDir,
        env,
        timeoutMs: 120_000,
      });
      await runCommand("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: repoDir, env });
    } else {
      await runCommand("git", ["checkout", "--detach", sha], { cwd: repoDir, env });
    }
  } catch (error) {
    console.warn(
      `[CloudInstall] Published commit ${sha.slice(0, 12)} unavailable, using latest: ` +
        redactGitCloneErrorMessage((error as Error).message).slice(0, 160),
    );
  }
}

export async function cloneCloudAppSource(
  input: CloudGitCloneInput,
  tempPrefix: string,
): Promise<CloudGitCloneResult> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), tempPrefix));
  const repoDir = path.join(tempRoot, "repo");
  const cloneUrl = authCloneUrl(input.cloneUrl, input.token);
  const env = ephemeralGitEnv();

  if (isAppRepoRootPath(input.repoPath)) {
    await runCommand(
      "git",
      ["clone", "--depth", "1", "--filter=blob:none", cloneUrl, repoDir],
      { env, timeoutMs: 180_000 },
    );
    await checkoutPublishedCommit(repoDir, input.commit, env, true);
    return {
      sourceDir: repoDir,
      repoDir,
      cleanup: async () => {
        await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
      },
    };
  }

  await runCommand(
    "git",
    ["clone", "--filter=blob:none", "--sparse", cloneUrl, repoDir],
    { env, timeoutMs: 180_000 },
  );
  await runCommand(
    "git",
    ["sparse-checkout", "set", input.repoPath.replace(/\\/g, "/")],
    { cwd: repoDir, env },
  );
  await checkoutPublishedCommit(repoDir, input.commit, env, false);

  return {
    sourceDir: path.join(repoDir, input.repoPath),
    repoDir,
    cleanup: async () => {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** Repo-relative directory for app source files on contribute push. */
export function appSourceRepoRelativeDir(
  repoPath: string,
  targetAppId: string,
): string {
  if (isAppRepoRootPath(repoPath)) {
    return ".";
  }
  return path.join("apps", targetAppId).replace(/\\/g, "/");
}

/** Repo-relative directory for linked job code on contribute push. */
export function linkedJobRepoRelativeDir(
  repoPath: string,
  jobId: string,
): string {
  if (isAppRepoRootPath(repoPath)) {
    return path.join("jobs", jobId).replace(/\\/g, "/");
  }
  return path.join("Jobs", jobId).replace(/\\/g, "/");
}
