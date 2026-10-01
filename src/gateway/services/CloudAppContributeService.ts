/**
 * Contribute-back PR flow — prepare → push branch on owner repo → submit (open PR).
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getPaprAppsRoot, getPaprRoot } from "../../core/utils/paprRoot.js";
import type { DatabasesRegistryFile } from "./DatabaseRegistryService.js";
import { CLOUD_LINEAGE_FILENAME } from "./CloudAppLineageService.js";
import { cloudApiFetch } from "../utils/cloudApiClient.js";
import { ephemeralGitEnv } from "../utils/ephemeralGitEnv.js";
import {
  cloneUrlMatchesAppRepo,
  resolveAppRepoForSync,
} from "./syncV3/AppRepoClient.js";
import { prepareAppForCloudGitSync } from "./cloudSync/prepareAppsForCloud.js";
import {
  readDataSourceRegistryDbIds,
  resolveAppDependentJobIds,
} from "./cloudSync/resolveAppDependentJobs.js";
import { resolveMigrationRootFromDbPath } from "./jobs/databaseMigrations.js";
import { applyIdRemapsToDirectory } from "../utils/applyIdRemaps.js";
import { mergeContributeDataIndexesIntoRepo } from "./cloudSync/contributeDataIndexMerge.js";
import { stripProposalExcludedAppFiles } from "./cloudSync/contributeProposalPaths.js";
import {
  applyProposableMetadata,
  hasMetadataChanges,
  metadataProposalFromLocal,
} from "./cloudSync/contributeMetadataFields.js";
import { parseCloudAppLineageFile } from "../../core/utils/cloudAppLineage.js";
import {
  appSourceRepoRelativeDir,
  linkedJobRepoRelativeDir,
} from "./cloudSync/cloudGitClone.js";

export interface ProposeContributeInput {
  sourceNamespaceId: string;
  sourceSlug: string;
  installedAppId: string;
  title: string;
  description: string;
}

export interface ProposeContributeResult {
  id: string;
  prUrl?: string;
  prNumber?: number;
  branch: string;
  headSha: string;
  status: string;
  stagedPaths: string[];
}

interface PrepareResponse {
  id: string;
  cloneUrl: string;
  token: string;
  expiresAt: string;
  branch: string;
  repoPath: string;
  targetAppId: string;
  status: string;
}

interface StagedRepoTree {
  /** Git-relative directory (e.g. apps/{id}, Jobs/{jobId}). */
  repoRelativeDir: string;
  files: Map<string, string>;
}

async function runCommand(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
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

function authCloneUrl(cloneUrl: string, token: string): string {
  const normalized = cloneUrl.replace(/^https:\/\//, "");
  return `https://x-access-token:${token}@${normalized}`;
}

async function readLineageId(installedAppId: string): Promise<string> {
  const lineagePath = path.join(
    getPaprAppsRoot(),
    installedAppId,
    CLOUD_LINEAGE_FILENAME,
  );
  const raw = await fs.readFile(lineagePath, "utf8");
  const parsed = JSON.parse(raw) as { lineageId?: string };
  if (!parsed.lineageId?.trim()) {
    throw new Error("Fork lineage missing — reinstall from cloud catalog");
  }
  return parsed.lineageId.trim();
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function collectTextFiles(
  rootDir: string,
  baseDir: string = rootDir,
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === CLOUD_LINEAGE_FILENAME) continue;
    if (entry.name.endsWith(".db") || entry.name.endsWith(".db-wal")) continue;

    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "venv") continue;
      const nested = await collectTextFiles(fullPath, baseDir);
      for (const [rel, content] of nested) {
        files.set(rel, content);
      }
      continue;
    }

    const relative = path.relative(baseDir, fullPath).replace(/\\/g, "/");
    const content = await fs.readFile(fullPath, "utf8");
    files.set(relative, content);
  }

  return files;
}

async function stageDirectoryWithRemaps(
  sourceDir: string,
  remaps: Map<string, string>,
  tempRoot: string,
  label: string,
): Promise<Map<string, string>> {
  const stagingDir = path.join(tempRoot, label);
  await fs.cp(sourceDir, stagingDir, { recursive: true });
  await applyIdRemapsToDirectory(stagingDir, remaps);
  return collectTextFiles(stagingDir);
}

async function readRegistryFile(paprDir: string): Promise<DatabasesRegistryFile | null> {
  try {
    const raw = await fs.readFile(
      path.join(paprDir, "data", "databases.json"),
      "utf8",
    );
    return JSON.parse(raw) as DatabasesRegistryFile;
  } catch {
    return null;
  }
}

/** Registry + job migration folders referenced by the fork (SQL only, no .db). */
async function collectMigrationTrees(
  paprDir: string,
  forkAppId: string,
  remaps: Map<string, string>,
  tempRoot: string,
): Promise<StagedRepoTree[]> {
  const trees: StagedRepoTree[] = [];
  const registry = await readRegistryFile(paprDir);

  for (const dbId of readDataSourceRegistryDbIds(paprDir, forkAppId)) {
    const record = registry?.databases?.[dbId];
    if (!record?.localPath) continue;
    const migrationRoot = resolveMigrationRootFromDbPath(record.localPath);
    if (!migrationRoot) continue;
    const migrationsDir = path.join(migrationRoot, "migrations");
    if (!(await pathExists(migrationsDir))) continue;

    const repoRelativeDir = path
      .relative(paprDir, migrationRoot)
      .replace(/\\/g, "/");
    const files = await stageDirectoryWithRemaps(
      migrationsDir,
      remaps,
      tempRoot,
      `registry-migrations-${dbId}`,
    );
    if (files.size > 0) {
      trees.push({
        repoRelativeDir: `${repoRelativeDir}/migrations`,
        files,
      });
    }
  }

  for (const jobId of resolveAppDependentJobIds(paprDir, forkAppId)) {
    const jobMigrations = path.join(paprDir, "Jobs", jobId, "migrations");
    if (!(await pathExists(jobMigrations))) continue;
    const files = await stageDirectoryWithRemaps(
      jobMigrations,
      remaps,
      tempRoot,
      `job-migrations-${jobId}`,
    );
    if (files.size > 0) {
      trees.push({
        repoRelativeDir: path.join("Jobs", jobId, "migrations").replace(/\\/g, "/"),
        files,
      });
    }
  }

  return trees;
}

async function buildContributeStaging(
  forkAppId: string,
  targetAppId: string,
  repoPath: string,
  tempRoot: string,
): Promise<StagedRepoTree[]> {
  const paprDir = getPaprRoot();
  await prepareAppForCloudGitSync(paprDir, forkAppId);

  const remaps = new Map<string, string>([[forkAppId, targetAppId]]);
  const trees: StagedRepoTree[] = [];
  const appRepoDir = appSourceRepoRelativeDir(repoPath, targetAppId);

  const forkAppDir = path.join(getPaprAppsRoot(), forkAppId);
  const appFiles = await stageDirectoryWithRemaps(
    forkAppDir,
    remaps,
    tempRoot,
    "app-staging",
  );
  // Build outputs + per-copy metadata stay at the owner's version on the
  // branch; the owner's publish regenerates them after the merge.
  stripProposalExcludedAppFiles(appFiles);
  if (appFiles.size > 0) {
    trees.push({
      repoRelativeDir: appRepoDir,
      files: appFiles,
    });
  }

  for (const jobId of resolveAppDependentJobIds(paprDir, forkAppId)) {
    const jobDir = path.join(paprDir, "Jobs", jobId);
    if (!(await pathExists(jobDir))) continue;
    const jobFiles = await stageDirectoryWithRemaps(
      jobDir,
      remaps,
      tempRoot,
      `job-${jobId}`,
    );
    if (jobFiles.size > 0) {
      trees.push({
        repoRelativeDir: linkedJobRepoRelativeDir(repoPath, jobId),
        files: jobFiles,
      });
    }
  }

  trees.push(...(await collectMigrationTrees(paprDir, forkAppId, remaps, tempRoot)));
  return trees;
}

async function writeStagedTree(
  repoDir: string,
  tree: StagedRepoTree,
): Promise<void> {
  const targetDir =
    tree.repoRelativeDir === "."
      ? repoDir
      : path.join(repoDir, tree.repoRelativeDir);
  for (const [relative, content] of tree.files) {
    const dest = path.join(targetDir, relative);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content, "utf8");
  }
}

/** Returns the repo-relative metadata.json path if it was changed. */
async function applyMetadataFieldProposal(
  repoDir: string,
  forkAppId: string,
  appRepoDir: string,
): Promise<string | null> {
  const forkDir = path.join(getPaprAppsRoot(), forkAppId);
  let lineageRaw: string;
  let localRaw: string;
  try {
    lineageRaw = await fs.readFile(path.join(forkDir, CLOUD_LINEAGE_FILENAME), "utf8");
    localRaw = await fs.readFile(path.join(forkDir, "metadata.json"), "utf8");
  } catch {
    return null;
  }
  const baseline = parseCloudAppLineageFile(lineageRaw)?.metadataBaseline;
  const changes = metadataProposalFromLocal(localRaw, baseline);
  if (!hasMetadataChanges(changes)) return null;

  const repoRel = appRepoDir === "." ? "metadata.json" : path.posix.join(appRepoDir, "metadata.json");
  const ownerPath = path.join(repoDir, repoRel);
  let ownerRaw: string;
  try {
    ownerRaw = await fs.readFile(ownerPath, "utf8");
  } catch {
    return null;
  }
  const next = applyProposableMetadata(ownerRaw, changes);
  if (!next) return null;
  await fs.writeFile(ownerPath, next, "utf8");
  console.info(
    `[CloudContribute] proposing metadata fields: ${Object.keys(changes).join(", ")}`,
  );
  return repoRel;
}

async function pushContributeBranch(
  prepare: PrepareResponse,
  forkAppId: string,
): Promise<{ headSha: string; stagedPaths: string[] }> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "papr-contrib-"));
  const repoDir = path.join(tempRoot, "repo");
  const env = ephemeralGitEnv();
  const cloneUrl = authCloneUrl(prepare.cloneUrl, prepare.token);

  const t0 = Date.now();
  let tPrev = t0;
  const timings: Record<string, number> = {};
  const mark = (step: string) => {
    const now = Date.now();
    timings[step] = now - tPrev;
    tPrev = now;
  };
  try {
    const trees = await buildContributeStaging(
      forkAppId,
      prepare.targetAppId,
      prepare.repoPath,
      tempRoot,
    );
    if (trees.length === 0) {
      throw new Error("No app or linked job files to contribute");
    }
    mark("stage");

    await runCommand(
      "git",
      ["clone", "--filter=blob:none", cloneUrl, repoDir],
      { env, timeoutMs: 180_000 },
    );
    mark("clone");

    await runCommand(
      "git",
      ["checkout", "-b", prepare.branch, "origin/main"],
      { cwd: repoDir, env },
    );
    mark("checkout");

    for (const tree of trees) {
      await writeStagedTree(repoDir, tree);
    }

    // metadata.json never ships whole; deliberate title/description/icon/tag
    // edits are applied field-by-field onto the owner's current file.
    const metadataRepoPath = await applyMetadataFieldProposal(
      repoDir,
      forkAppId,
      appSourceRepoRelativeDir(prepare.repoPath, prepare.targetAppId),
    );

    const indexMerge = await mergeContributeDataIndexesIntoRepo({
      repoDir,
      contributorPaprDir: getPaprRoot(),
      forkAppId,
      targetAppId: prepare.targetAppId,
    });

    const stagePaths = [
      ...new Set([
        ...trees.map((t) => t.repoRelativeDir),
        ...indexMerge.paths,
        ...(metadataRepoPath ? [metadataRepoPath] : []),
      ]),
    ];
    await runCommand("git", ["add", "--", ...stagePaths], {
      cwd: repoDir,
      env,
    });

    const staged = (
      await runCommand("git", ["diff", "--cached", "--name-only"], {
        cwd: repoDir,
        env,
      })
    ).trim();
    if (!staged) {
      throw new Error("No changes to contribute — fork matches upstream");
    }

    const commitMsg = `contrib: ${prepare.branch}\n\nContribute-back from ${forkAppId}`;
    await runCommand("git", ["commit", "-m", commitMsg], { cwd: repoDir, env });
    mark("write+commit");

    await runCommand(
      "git",
      ["push", "-u", "origin", prepare.branch],
      { cwd: repoDir, env, timeoutMs: 180_000 },
    );
    mark("push");
    console.info(
      `[CloudContribute] push ${prepare.branch} total=${Date.now() - t0}ms`,
      timings,
    );

    const headSha = (
      await runCommand("git", ["rev-parse", "HEAD"], { cwd: repoDir, env })
    ).trim();
    if (!headSha) {
      throw new Error("Failed to resolve commit SHA after push");
    }
    return { headSha, stagedPaths: stagePaths };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export class CloudAppContributeService {
  async propose(input: ProposeContributeInput): Promise<ProposeContributeResult> {
    const lineageId = await readLineageId(input.installedAppId);

    const { getPaprCallerIdentity } = await import("../utils/paprUserId.js");
    const proposer = getPaprCallerIdentity();

    const prepareResp = await cloudApiFetch("/v1/cloud/apps/changes/prepare", {
      method: "POST",
      body: {
        lineageId,
        sourceNamespaceId: input.sourceNamespaceId,
        sourceSlug: input.sourceSlug,
        installedAppId: input.installedAppId,
        title: input.title.trim(),
        description: input.description.trim(),
        ...(proposer.userId ? { proposerUserId: proposer.userId } : {}),
        ...(proposer.displayName
          ? { proposerDisplayName: proposer.displayName }
          : {}),
        ...(proposer.email ? { proposerEmail: proposer.email } : {}),
      },
    });
    if (!prepareResp.ok) {
      const text = await prepareResp.text();
      throw new Error(
        `Prepare contribute failed (${prepareResp.status}): ${text.slice(0, 200)}`,
      );
    }

    const prepare = (await prepareResp.json()) as PrepareResponse;

    const ownerRepo = await resolveAppRepoForSync(prepare.targetAppId);
    if (ownerRepo && !cloneUrlMatchesAppRepo(prepare.cloneUrl, ownerRepo)) {
      console.warn(
        `[CloudContribute] prepare.cloneUrl does not match RepoRegistry for ${prepare.targetAppId}`,
      );
    }

    const { headSha, stagedPaths } = await pushContributeBranch(
      prepare,
      input.installedAppId,
    );

    const submitResp = await cloudApiFetch(
      `/v1/cloud/apps/changes/${encodeURIComponent(prepare.id)}/submit`,
      {
        method: "POST",
        body: { headSha, stagedPaths },
      },
    );
    if (!submitResp.ok) {
      const text = await submitResp.text();
      throw new Error(
        `Submit contribute failed (${submitResp.status}): ${text.slice(0, 200)}`,
      );
    }

    const submitted = (await submitResp.json()) as {
      id: string;
      prUrl?: string;
      prNumber?: number;
      status: string;
    };
    // Record what was sent so the share bar stops showing "Edits not proposed".
    // Done here (not in the HTTP route) so the agent tool path does it too.
    try {
      const { getCloudAppTrackSyncService } = await import(
        "./CloudAppTrackSyncService.js"
      );
      await getCloudAppTrackSyncService().recordProposed(input.installedAppId);
      // Tell the open share bar to re-read (chip -> "Waiting for review").
      const { notifyCloudSyncItemsStale } = await import(
        "./cloudSync/cloudSyncBroadcast.js"
      );
      notifyCloudSyncItemsStale(input.installedAppId);
    } catch {
      // Proposal is already submitted; never fail it over bookkeeping.
    }
    return {
      id: submitted.id,
      prUrl: submitted.prUrl,
      prNumber: submitted.prNumber,
      branch: prepare.branch,
      headSha,
      status: submitted.status,
      stagedPaths,
    };
  }
}

let instance: CloudAppContributeService | null = null;

export function getCloudAppContributeService(): CloudAppContributeService {
  if (!instance) {
    instance = new CloudAppContributeService();
  }
  return instance;
}
