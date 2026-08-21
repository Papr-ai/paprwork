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
      reject(
        new Error(
          `${command} ${args.join(" ")} failed (${code ?? "unknown"}): ${stderr.trim()}`,
        ),
      );
    });
  });
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
