/**
 * Shallow git worktree for app-repo-writer.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AppRepoRecord } from "../../../core/types/appRepoRegistry.js";
import type { AppRepoOpFile } from "../../../core/types/appRepoWriterOps.js";
import { GitRunner } from "../cloudSync/gitRunner.js";
import { cloneUrlWithToken, getGithubInstallationToken } from "./githubAppAuth.js";
import { listHeadFileOids, verifyParentHashes } from "./parentHashVerify.js";
import { hashBlobContent } from "../syncV3/computeParentHash.js";

const WORK_ROOT = path.join(os.tmpdir(), "papr-app-repo-writer");

function repoWorkDir(record: AppRepoRecord): string {
  return path.join(WORK_ROOT, record.githubOrg, record.repoName);
}

async function ensureRepoCheckout(record: AppRepoRecord): Promise<{
  cwd: string;
  runGit: (args: string[], opts?: { timeout?: number }) => Promise<string>;
}> {
  const cwd = repoWorkDir(record);
  await fs.mkdir(path.dirname(cwd), { recursive: true });
  const runner = new GitRunner();
  const runGit = (args: string[], opts?: { timeout?: number }) =>
    runner.run(args, { cwd, ...opts });

  const hasGit = await runner.isRepoAtRoot(cwd);
  if (!hasGit) {
    const token = await getGithubInstallationToken();
    const authedUrl = cloneUrlWithToken(record.cloneUrl, token);
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.mkdir(path.dirname(cwd), { recursive: true });
    await runner.clone(authedUrl, cwd);
    return { cwd, runGit };
  }

  try {
    const token = await getGithubInstallationToken();
    const authedUrl = cloneUrlWithToken(record.cloneUrl, token);
    await runGit(["remote", "set-url", "origin", authedUrl]);
    await runGit(["fetch", "--depth", "1", "origin", "main"], { timeout: 120_000 });
    await runGit(["reset", "--hard", "origin/main"], { timeout: 60_000 });
  } catch {
    /* best-effort refresh */
  }

  return { cwd, runGit };
}

export interface ApplyOpsResult {
  commitSha: string;
  files: Array<{ path: string; blobOid: string }>;
}

export async function applyAppRepoOps(
  record: AppRepoRecord,
  files: readonly AppRepoOpFile[],
  message: string,
  author: string,
): Promise<ApplyOpsResult> {
  const { cwd, runGit } = await ensureRepoCheckout(record);

  const mismatches = await verifyParentHashes(runGit, files);
  if (mismatches.length > 0) {
    const err = new Error("parentHash mismatch");
    (err as Error & { mismatches: typeof mismatches }).mismatches = mismatches;
    throw err;
  }

  for (const file of files) {
    const target = path.join(cwd, file.path);
    if (file.content === null) {
      await fs.rm(target, { force: true });
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, "utf8");
  }

  await runGit(["add", "-A"]);
  const authorArg = `${author} <sync@papr.ai>`;
  await runGit(
    [
      "-c",
      `user.name=${author}`,
      "-c",
      `user.email=sync@papr.ai`,
      "commit",
      "-m",
      message,
      "--author",
      authorArg,
    ],
    { timeout: 60_000 },
  );

  // Push with non-fast-forward retry: another writer instance may have pushed
  // between our fetch and push. Defense-in-depth alongside the repo lock —
  // fetch + rebase our commit onto the new remote head and retry.
  const PUSH_ATTEMPTS = 3;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await runGit(["push", "origin", "HEAD:main"], { timeout: 120_000 });
      break;
    } catch (err) {
      const msg = (err as Error).message ?? "";
      const nonFastForward =
        /non-fast-forward|fetch first|rejected/i.test(msg);
      if (!nonFastForward || attempt >= PUSH_ATTEMPTS) {
        throw err;
      }
      await runGit(["fetch", "origin", "main"], { timeout: 60_000 });
      await runGit(["rebase", "origin/main"], { timeout: 60_000 });
    }
  }
  const commitSha = (await runGit(["rev-parse", "HEAD"])).trim();

  const ackedFiles: Array<{ path: string; blobOid: string }> = [];
  for (const file of files) {
    if (file.content === null) {
      continue;
    }
    ackedFiles.push({
      path: file.path,
      blobOid: hashBlobContent(file.content),
    });
  }

  return { commitSha, files: ackedFiles };
}

export async function readAppRepoHead(
  record: AppRepoRecord,
): Promise<{ commitSha: string; files: Array<{ path: string; blobOid: string }> }> {
  const { runGit } = await ensureRepoCheckout(record);
  const commitSha = (await runGit(["rev-parse", "HEAD"])).trim();
  const files = await listHeadFileOids(runGit);
  return { commitSha, files };
}

/** Test-only — remove work dir. */
export async function clearWriterWorktreesForTests(): Promise<void> {
  await fs.rm(WORK_ROOT, { recursive: true, force: true });
}
