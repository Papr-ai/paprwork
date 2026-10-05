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
import { buildProposalChangeSet, type ProposalTree } from "./cloudSync/contributeChangeSet.js";
import {
  inferOwnDataDbIdMap,
  invertDbIdMap,
  publisherMigrationsDir,
  remapDbIdsInContent,
} from "./cloudSync/ownDataDbIdMap.js";
import { isLocalScratchPath } from "./cloudSync/proposalFileMerge.js";
import {
  previewMergeConflicts,
  readFilesAtCommit,
  resolveBaseCommit,
} from "./cloudSync/threeWayMerge.js";
import { hashBlobContent } from "./syncV3/computeParentHash.js";
import { isCollaboratorEditablePath } from "./CloudAppTrackSyncService.js";
import type { CloudAppLineageFile } from "../../core/types/cloudAppLineage.js";
import {
  applyProposableMetadata,
  hasMetadataChanges,
  metadataProposalFromLocal,
} from "./cloudSync/contributeMetadataFields.js";
import { parseCloudAppLineageFile } from "../../core/utils/cloudAppLineage.js";
import {
  appSourceRepoRelativeDir,
  isAppRepoRootPath,
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
  const parsed = JSON.parse(raw) as { lineageId?: string; detachedAt?: string };
  // Detach is one-way: the copy no longer follows or proposes to the original.
  // The server still has the lineage (kept for credit), so refuse here.
  if (parsed.detachedAt) {
    throw Object.assign(
      new Error("This copy was detached from the original, so it can't propose changes to it."),
      { code: "copy_detached" },
    );
  }
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

/** local dbId → publisher dbId for a copy on its own data (empty otherwise). */
async function ownDataDbIdsToPublisher(
  staged: StagedProposalTree[],
  lineage: CloudAppLineageFile | null,
  repoDir: string,
  baseSha: string,
  env: NodeJS.ProcessEnv,
): Promise<Map<string, string>> {
  if (!lineage) return new Map();
  const { usesSharedData } = await import("../../core/utils/copyAxes.js");
  if (usesSharedData(lineage)) return new Map();
  const app = staged.find((t) => t.kind === "app");
  const local = app?.files.get("data-sources.json");
  if (!app || !local) return new Map();
  const publisherFiles = await readFilesAtCommit(repoDir, baseSha, app.repoRelativeDir, env);
  return invertDbIdMap(inferOwnDataDbIdMap(local, publisherFiles.get("data-sources.json")));
}

interface StagedProposalTree {
  repoRelativeDir: string;
  files: Map<string, string>;
  kind: "app" | "job" | "migrations";
}

/** Local side of a proposal: app folder, linked Jobs/{id}, registry migrations. */
async function buildContributeStaging(
  forkAppId: string,
  targetAppId: string,
  repoPath: string,
  tempRoot: string,
): Promise<StagedProposalTree[]> {
  const paprDir = getPaprRoot();
  await prepareAppForCloudGitSync(paprDir, forkAppId);

  const remaps = new Map<string, string>([[forkAppId, targetAppId]]);
  const trees: StagedProposalTree[] = [];

  const forkAppDir = path.join(getPaprAppsRoot(), forkAppId);
  const appFiles = await stageDirectoryWithRemaps(forkAppDir, remaps, tempRoot, "app-staging");
  trees.push({
    repoRelativeDir: appSourceRepoRelativeDir(repoPath, targetAppId),
    files: appFiles,
    kind: "app",
  });

  for (const jobId of resolveAppDependentJobIds(paprDir, forkAppId)) {
    const jobDir = path.join(paprDir, "Jobs", jobId);
    if (!(await pathExists(jobDir))) continue;
    const jobFiles = await stageDirectoryWithRemaps(jobDir, remaps, tempRoot, `job-${jobId}`);
    trees.push({
      repoRelativeDir: linkedJobRepoRelativeDir(repoPath, jobId),
      files: jobFiles,
      kind: "job",
    });
  }

  for (const tree of await collectMigrationTrees(paprDir, forkAppId, remaps, tempRoot)) {
    let dir = tree.repoRelativeDir;
    // Per-app repos keep schema-owner migrations at databases/{slug}/migrations
    // (see syncV3/collectAppOpFiles.ts), not the workspace's data/databases/.
    if (isAppRepoRootPath(repoPath) && dir.startsWith("data/databases/")) {
      dir = dir.slice("data/".length);
    }
    trees.push({ repoRelativeDir: dir, files: tree.files, kind: "migrations" });
  }
  return trees;
}

/** Repo-path → blob id of local files that should match the publisher verbatim. */
function localBlobIdsForInference(trees: StagedProposalTree[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const tree of trees) {
    if (tree.kind === "migrations") continue;
    for (const [rel, content] of tree.files) {
      if (isLocalScratchPath(rel, { job: tree.kind === "job" })) continue;
      if (tree.kind === "job" && rel === "job.json") continue;
      if (tree.kind === "app") {
        if (!isCollaboratorEditablePath(rel) || rel === "README.md" || rel.startsWith("jobs/")) continue;
      }
      const repoPath = tree.repoRelativeDir === "." ? rel : `${tree.repoRelativeDir}/${rel}`;
      out.set(repoPath, hashBlobContent(content));
    }
  }
  return out;
}

async function pushContributeBranch(
  prepare: PrepareResponse,
  forkAppId: string,
): Promise<{ headSha: string; stagedPaths: string[]; baseCommit: string }> {
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
    const staged = await buildContributeStaging(
      forkAppId,
      prepare.targetAppId,
      prepare.repoPath,
      tempRoot,
    );
    mark("stage");

    await runCommand("git", ["clone", "--filter=blob:none", "--no-checkout", cloneUrl, repoDir], {
      env,
      timeoutMs: 180_000,
    });
    mark("clone");

    // Branch from the commit this copy is based on — not the publisher's
    // latest main. Files the publisher changed since then are untouched by
    // the branch, and GitHub's three-way merge decides what actually overlaps.
    let lineage: CloudAppLineageFile | null = null;
    try {
      lineage = parseCloudAppLineageFile(
        await fs.readFile(path.join(getPaprAppsRoot(), forkAppId, CLOUD_LINEAGE_FILENAME), "utf8"),
      );
    } catch {
      lineage = null;
    }
    const base = await resolveBaseCommit(
      repoDir,
      lineage?.baseCommit,
      async () => localBlobIdsForInference(staged),
      env,
    );
    if (!base) {
      throw new Error(
        "Couldn't tell which version of the publisher's app this copy is based on. " +
          "Get the publisher's updates first, then propose again.",
      );
    }
    if (base.inferred) {
      console.info(`[CloudContribute] inferred base commit ${base.sha.slice(0, 12)} for ${forkAppId}`);
    }
    mark("base");

    // A copy on its own data has fresh database ids; propose in the
    // publisher's ids, or approving re-wires their app to our databases.
    const dbToPublisher = await ownDataDbIdsToPublisher(staged, lineage, repoDir, base.sha, env);
    for (const tree of staged) {
      if (dbToPublisher.size === 0) break;
      for (const [rel, content] of tree.files) {
        tree.files.set(rel, remapDbIdsInContent(content, dbToPublisher));
      }
      if (tree.kind === "migrations") {
        tree.repoRelativeDir = publisherMigrationsDir(tree.repoRelativeDir, dbToPublisher);
      }
    }

    const hasJobTrees = staged.some((t) => t.kind === "job");
    const trees: ProposalTree[] = [];
    for (const tree of staged) {
      trees.push({
        repoDir: tree.repoRelativeDir,
        local: tree.files,
        base: await readFilesAtCommit(repoDir, base.sha, tree.repoRelativeDir, env, tree.files),
        kind: tree.kind,
        // The app folder's bundled jobs/ copy is stale once Jobs/{id} exists;
        // the job trees own those paths.
        ...(tree.kind === "app" && hasJobTrees ? { skipPrefixes: ["jobs/"] } : {}),
      });
    }
    const changes = buildProposalChangeSet(trees);
    if (changes.ignored.length > 0) {
      console.info(
        `[CloudContribute] left out platform-rewritten files: ${changes.ignored.join(", ")}`,
      );
    }
    mark("diff");

    await runCommand("git", ["checkout", "-b", prepare.branch, base.sha], { cwd: repoDir, env });
    mark("checkout");

    for (const [repoPath, content] of changes.writes) {
      const dest = path.join(repoDir, repoPath);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, content, "utf8");
    }
    for (const repoPath of changes.deletes) {
      await fs.rm(path.join(repoDir, repoPath), { force: true });
    }

    // metadata.json never ships whole; deliberate title/description/icon/tag
    // edits are applied field-by-field onto the publisher's file.
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
      // The copy's own instances of the publisher's databases aren't new ones.
      skipDbIds: new Set(dbToPublisher.keys()),
    });

    const stagePaths = [
      ...new Set([
        ...changes.writes.keys(),
        ...changes.deletes,
        ...indexMerge.paths,
        ...(metadataRepoPath ? [metadataRepoPath] : []),
      ]),
    ].sort();
    if (stagePaths.length === 0) {
      throw new Error("No changes to contribute — your copy matches the publisher's");
    }
    await runCommand("git", ["add", "-A", "--", ...stagePaths], { cwd: repoDir, env });

    const stagedNames = (
      await runCommand("git", ["diff", "--cached", "--name-only"], { cwd: repoDir, env })
    ).trim();
    if (!stagedNames) {
      throw new Error("No changes to contribute — your copy matches the publisher's");
    }

    const commitMsg = `contrib: ${prepare.branch}\n\nContribute-back from ${forkAppId} (base ${base.sha.slice(0, 12)})`;
    await runCommand("git", ["commit", "-m", commitMsg], { cwd: repoDir, env });
    mark("write+commit");

    // Same check GitHub will do on approve, done before anything is sent:
    // edits that overlap lines the publisher changed since the base.
    const conflicts = await previewMergeConflicts(repoDir, "origin/main", "HEAD", env);
    if (conflicts && conflicts.length > 0) {
      throw Object.assign(
        new Error(
          `Your edits overlap changes the publisher made since your copy was updated (${conflicts
            .slice(0, 6)
            .join(", ")}${conflicts.length > 6 ? ", …" : ""}). Get the publisher's updates, resolve those files, then propose again.`,
        ),
        { code: "contribute_conflicts", conflictFiles: conflicts },
      );
    }
    mark("conflict-check");

    await runCommand("git", ["push", "-u", "origin", prepare.branch], {
      cwd: repoDir,
      env,
      timeoutMs: 180_000,
    });
    mark("push");
    console.info(
      `[CloudContribute] push ${prepare.branch} files=${stagedNames.split("\n").length} total=${Date.now() - t0}ms`,
      timings,
    );

    const headSha = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: repoDir, env })).trim();
    if (!headSha) {
      throw new Error("Failed to resolve commit SHA after push");
    }
    return { headSha, stagedPaths: stagedNames.split("\n").filter(Boolean), baseCommit: base.sha };
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
