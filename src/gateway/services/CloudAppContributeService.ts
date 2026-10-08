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
import { isProposalExcludedAppPath } from "./cloudSync/contributeProposalPaths.js";
import { mergeContributeDataIndexesIntoRepo } from "./cloudSync/contributeDataIndexMerge.js";
import { buildProposalChangeSet, type ProposalTree } from "./cloudSync/contributeChangeSet.js";
import {
  inferOwnDataDbIdMap,
  invertDbIdMap,
  ownInstanceDbIds,
  publisherMigrationsDir,
  remapDbIdsInContent,
  stripDbIdsFromProposalFile,
} from "./cloudSync/ownDataDbIdMap.js";
import { isLocalScratchPath } from "./cloudSync/proposalFileMerge.js";
import {
  planJobFold,
  readPublisherJobsAtCommit,
  remapJobIdsInContent,
} from "./cloudSync/contributeJobIdentity.js";
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
  restoredIds?: ReadonlySet<string>;
  appliedIds?: ReadonlySet<string> | null;
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
    // Rejected / quarantined migrations stay on disk for reference, never in a proposal.
    if (entry.name === "_quarantine") continue;
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
/** dbIds the publisher's app already links at the proposal's base commit. */
function publisherLinkedDbIds(trees: ProposalTree[]): string[] {
  const app = trees.find((t) => t.kind === "app");
  if (!app) return [];
  const ids = new Set<string>();
  for (const rel of ["data-sources.json", "linked-databases.json"]) {
    for (const id of app.base.get(rel)?.match(/db-[0-9a-f]{8}(?![0-9a-f])/g) ?? []) ids.add(id);
  }
  return [...ids];
}

/**
 * Migration ids that ran on this copy's database: the local ledger plus any
 * held for proposal (teammate on shared data). null when the ledger can't be
 * read — the proposal then refuses rather than guessing.
 */
export async function appliedMigrationIdsForProposal(
  dbId: string,
  dbPath: string,
): Promise<Set<string> | null> {
  const { queryRegistryDatabase } = await import("./jobs/registryDbSchemaReader.js");
  const ledger = await queryRegistryDatabase({ dbPath, dbId }, "SELECT id FROM schema_migrations");
  if (!ledger) return null;
  const ids = new Set(ledger.rows.map((row) => String(row.id ?? "").replace(/\.sql$/, "")));
  const { getReplicaPublishHold } = await import("./tursoReplica/replicaPublishHold.js");
  for (const m of getReplicaPublishHold(dbPath)?.migrations ?? []) ids.add(m.migrationId);
  return ids;
}

/** Proposals never carry a migration that didn't run here (it would run untested on approve). */
export function assertProposalMigrationsApplied(changes: { unapplied: string[]; unverified: string[] }): void {
  if (changes.unapplied.length > 0) {
    throw new Error(
      `These migration files never ran on this copy's database: ${changes.unapplied.join(", ")}. ` +
        "Apply them (papr_db_apply_migration) and test, or remove them, then propose again.",
    );
  }
  if (changes.unverified.length > 0) {
    throw new Error(
      `Couldn't read this copy's migration ledger to confirm ${changes.unverified.join(", ")} ran. ` +
        "Check the database with papr_db_sync_status, then propose again.",
    );
  }
}

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
      const { readRestoredManifest } = await import("./jobs/restoredMigrations.js");
      const restoredIds = new Set((await readRestoredManifest(migrationRoot)).map((r) => r.id));
      trees.push({
        repoRelativeDir: `${repoRelativeDir}/migrations`,
        files,
        restoredIds,
        appliedIds: await appliedMigrationIdsForProposal(dbId, record.localPath),
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

async function ownInstanceIdsForProposal(
  staged: StagedProposalTree[],
  lineage: CloudAppLineageFile | null,
  repoDir: string,
  baseSha: string,
  env: NodeJS.ProcessEnv,
): Promise<Set<string>> {
  if (!lineage) return new Set();
  const app = staged.find((t) => t.kind === "app");
  const local = app?.files.get("data-sources.json");
  if (!app || !local) return new Set();
  const publisherFiles = await readFilesAtCommit(repoDir, baseSha, app.repoRelativeDir, env);
  return ownInstanceDbIds(local, publisherFiles.get("data-sources.json"));
}

interface StagedProposalTree {
  repoRelativeDir: string;
  files: Map<string, string>;
  kind: "app" | "job" | "migrations";
  restoredIds?: ReadonlySet<string>;
  appliedIds?: ReadonlySet<string> | null;
  /** Local job id (job trees only). */
  jobId?: string;
  /** Duplicate job folded onto the publisher's job: never propose deletions. */
  folded?: boolean;
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

  const { jobOwnedByApp } = await import("./jobs/appIdPlaceholder.js");
  for (const jobId of resolveAppDependentJobIds(paprDir, forkAppId)) {
    const jobDir = path.join(paprDir, "Jobs", jobId);
    if (!(await pathExists(jobDir))) continue;
    // A job another app owns (shared job folder) must never ride along with this
    // copy's proposal — it would re-point the owner's job at a different app.
    if (!(await jobOwnedByApp(jobDir, forkAppId))) {
      console.info(`[CloudContribute] skipping job ${jobId}: not owned by ${forkAppId}`);
      continue;
    }
    const jobFiles = await stageDirectoryWithRemaps(jobDir, remaps, tempRoot, `job-${jobId}`);
    trees.push({
      repoRelativeDir: linkedJobRepoRelativeDir(repoPath, jobId),
      files: jobFiles,
      kind: "job",
      jobId,
    });
  }

  for (const tree of await collectMigrationTrees(paprDir, forkAppId, remaps, tempRoot)) {
    let dir = tree.repoRelativeDir;
    // Per-app repos keep schema-owner migrations at databases/{slug}/migrations
    // (see syncV3/collectAppOpFiles.ts), not the workspace's data/databases/.
    if (isAppRepoRootPath(repoPath) && dir.startsWith("data/databases/")) {
      dir = dir.slice("data/".length);
    }
    trees.push({
      repoRelativeDir: dir,
      files: tree.files,
      kind: "migrations",
      restoredIds: tree.restoredIds,
      ...(tree.appliedIds !== undefined ? { appliedIds: tree.appliedIds } : {}),
    });
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

/**
 * Propose in the publisher's job ids (see cloudSync/contributeJobIdentity.ts):
 * a same-name duplicate the app calls is proposed as the publisher's job, an
 * uncalled one is left out. Mutates `staged` in place.
 */
async function foldDuplicateJobs(
  staged: StagedProposalTree[],
  repoDir: string,
  baseSha: string,
  repoPath: string,
  env: NodeJS.ProcessEnv,
): Promise<{ proposalJobIds: string[]; newJobIds: string[] }> {
  const jobTrees = staged.filter((t) => t.kind === "job" && t.jobId);
  const jobsRoot = linkedJobRepoRelativeDir(repoPath, "x").split("/").slice(0, -1).join("/");
  const publisherJobs = await readPublisherJobsAtCommit(repoDir, baseSha, jobsRoot, env);
  const publisherIds = new Set(publisherJobs.map((j) => j.id));
  const app = staged.find((t) => t.kind === "app");
  const appCode = app
    ? [...app.files]
        // Source only: build outputs (dist/) are stale copies that still
        // name the job the source stopped calling.
        .filter(([rel]) => !rel.startsWith("jobs/") && !isProposalExcludedAppPath(rel))
        .map(([, c]) => c)
        .join("\n")
    : "";
  const localJobs = jobTrees.map((t) => {
    let name: string | undefined;
    try {
      name = (JSON.parse(t.files.get("job.json") ?? "{}") as { name?: string }).name;
    } catch {
      /* unnamed */
    }
    return { id: t.jobId!, name };
  });
  const plan = planJobFold({ localJobs, publisherJobs, appCode });

  for (const id of plan.drop) {
    console.info(`[CloudContribute] left out job ${id}: duplicate of a publisher job, not used by the app`);
  }
  for (const [dupId, targetId] of plan.remap) {
    const stale = staged.findIndex((t) => t.kind === "job" && t.jobId === targetId);
    if (stale >= 0) {
      console.info(
        `[CloudContribute] job ${dupId} duplicates publisher job ${targetId} and is the one the app runs; ` +
          `proposing its files as ${targetId} (local ${targetId} copy left out)`,
      );
      staged.splice(stale, 1);
    }
    const dup = staged.find((t) => t.kind === "job" && t.jobId === dupId);
    if (dup) {
      dup.repoRelativeDir = linkedJobRepoRelativeDir(repoPath, targetId);
      dup.folded = true;
    }
  }
  for (let i = staged.length - 1; i >= 0; i--) {
    const tree = staged[i];
    if (tree.kind === "job" && tree.jobId && plan.drop.has(tree.jobId)) staged.splice(i, 1);
  }
  if (plan.remap.size > 0) {
    for (const tree of staged) {
      for (const [rel, content] of tree.files) {
        tree.files.set(rel, remapJobIdsInContent(content, plan.remap));
      }
    }
  }

  const kept = staged.filter((t) => t.kind === "job" && t.jobId).map((t) => t.jobId!);
  return {
    proposalJobIds: kept,
    newJobIds: kept.filter((id) => !publisherIds.has(id) && !plan.remap.has(id)),
  };
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
    const ownIds = await ownInstanceIdsForProposal(staged, lineage, repoDir, base.sha, env);
    for (const id of dbToPublisher.keys()) ownIds.delete(id);
    if (ownIds.size > 0) {
      const app = staged.find((t) => t.kind === "app");
      for (const rel of ["data-sources.json", "linked-databases.json"]) {
        const content = app?.files.get(rel);
        if (app && content !== undefined) app.files.set(rel, stripDbIdsFromProposalFile(rel, content, ownIds));
      }
    }
    for (const tree of staged) {
      if (dbToPublisher.size === 0) break;
      for (const [rel, content] of tree.files) {
        tree.files.set(rel, remapDbIdsInContent(content, dbToPublisher));
      }
      if (tree.kind === "migrations") {
        tree.repoRelativeDir = publisherMigrationsDir(tree.repoRelativeDir, dbToPublisher);
      }
    }

    const jobIdentity = await foldDuplicateJobs(staged, repoDir, base.sha, prepare.repoPath, env);

    const hasJobTrees = staged.some((t) => t.kind === "job");
    const trees: ProposalTree[] = [];
    for (const tree of staged) {
      trees.push({
        repoDir: tree.repoRelativeDir,
        local: tree.files,
        base: await readFilesAtCommit(repoDir, base.sha, tree.repoRelativeDir, env, tree.files),
        kind: tree.kind,
        ...(tree.restoredIds ? { restoredIds: tree.restoredIds } : {}),
        ...(tree.appliedIds !== undefined ? { appliedIds: tree.appliedIds } : {}),
        ...(tree.folded ? { noDeletes: true } : {}),
        // The app folder's bundled jobs/ copy is stale once Jobs/{id} exists;
        // the job trees own those paths.
        ...(tree.kind === "app" && hasJobTrees ? { skipPrefixes: ["jobs/"] } : {}),
      });
    }
    const changes = buildProposalChangeSet(trees);
    assertProposalMigrationsApplied(changes);
    if (changes.ignored.length > 0) {
      console.info(
        `[CloudContribute] left out platform-rewritten files: ${changes.ignored.join(", ")}`,
      );
    }
    if (changes.restored.length > 0) {
      console.info(`[CloudContribute] restored (already-applied) migrations: ${changes.restored.join(", ")}`);
    }
    if (changes.immutableSkipped.length > 0) {
      console.info(`[CloudContribute] kept publisher's applied migrations: ${changes.immutableSkipped.join(", ")}`);
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
      // The copy's own instances of the publisher's databases aren't new ones,
      // and databases the publisher already links are theirs to describe.
      skipDbIds: new Set([...dbToPublisher.keys(), ...ownIds, ...publisherLinkedDbIds(trees)]),
      proposalJobIds: jobIdentity.proposalJobIds,
      newJobIds: jobIdentity.newJobIds,
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
      {
        const { noteGitHubRateLimit, GitHubPausedError } = await import("./githubRateGate.js");
        const wait = noteGitHubRateLimit(prepareResp.status, prepareResp.headers, text, "propose");
        if (wait !== null) throw new GitHubPausedError(wait, "propose");
      }
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
      {
        const { noteGitHubRateLimit, GitHubPausedError } = await import("./githubRateGate.js");
        const wait = noteGitHubRateLimit(submitResp.status, submitResp.headers, text, "propose");
        if (wait !== null) throw new GitHubPausedError(wait, "propose");
      }
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
