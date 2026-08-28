/**
 * Collect repo-relative file ops for an app flush (Sync V3 writer path).
 *
 * App source → repo root (metadata.json, index.html, …)
 * Linked jobs → jobs/{jobId}/…
 * Schema-owner migrations → databases/{slug}/migrations/…
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { AppRepoOpFile } from "../../../core/types/appRepoWriterOps.js";
import {
  filterAbusiveOpFiles,
  isNeverTrackRepoPath,
} from "../appRepoWriter/abuseFilter.js";
import { resolveAppDependentJobIds } from "../cloudSync/resolveAppDependentJobs.js";
import {
  formatGitSyncSizeLimitMb,
  isTooLargeForGitSync,
  MAX_GIT_SYNC_FILE_BYTES,
} from "../cloudSync/gitSyncLimits.js";
import {
  DATABASES_REGISTRY_FILENAME,
  type DatabaseRecord,
  type DatabasesRegistryFile,
  registrySlugFromLocalPath,
} from "../DatabaseRegistryService.js";
import { parseMonolithicJobJson } from "../jobs/jobRuntimeFields.js";
import { computeBlobOidForContent } from "./computeParentHash.js";
import { readOidCache } from "./OidCache.js";

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist-demo",
  "__pycache__",
  ".venv",
  "venv",
]);

/** Dotfiles excluded from git sync except these (cache revision for apps.papr.ai). */
const ALLOWED_DOTFILE_NAMES = new Set([".papr-cloud-revision"]);

const JOB_SKIP_DIR_NAMES = new Set([...SKIP_DIR_NAMES, "data", "logs"]);

const JOB_SKIP_FILE_NAMES = new Set(["job.runtime.json"]);

const JOB_SKIP_EXTENSIONS = new Set([".db", ".pyc", ".log", ".wal", ".shm"]);

/**
 * Ceiling on the content a single flush may carry.
 *
 * One flush becomes one outbox line and one writer request. Without a ceiling,
 * an app folder holding a few hundred assets produced a ~400MB op that could
 * neither be pushed nor held in memory, and every retry rebuilt it. Files past
 * the budget are deferred to the next flush, so a large app converges over
 * several passes instead of failing on all of them.
 *
 * Sized below the outbox line cap to leave room for JSON escaping.
 */
export const MAX_OP_BATCH_CONTENT_BYTES = 6 * 1024 * 1024;

interface WalkCandidate {
  repoPath: string;
  fullPath: string;
  readContent?: () => Promise<string>;
}

async function walkAppFiles(appDir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(currentDir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") && !ALLOWED_DOTFILE_NAMES.has(entry.name)) {
        continue;
      }
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) {
          continue;
        }
        await walk(full, rel);
        continue;
      }
      if (entry.isFile()) {
        const repoPath = rel.replace(/\\/g, "/");
        // Excluded here rather than after reading: this walk covers app
        // folders that hold SQLite databases and their `.bak` copies, and
        // reading one of those as a string is what exhausted the heap.
        if (isNeverTrackRepoPath(repoPath)) {
          continue;
        }
        results.push(repoPath);
      }
    }
  }

  await walk(appDir, "");
  return results.sort();
}

async function walkJobFiles(
  jobDir: string,
  jobId: string,
): Promise<WalkCandidate[]> {
  const results: WalkCandidate[] = [];

  async function walk(currentDir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (JOB_SKIP_DIR_NAMES.has(entry.name)) {
          continue;
        }
        await walk(full, rel);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (JOB_SKIP_FILE_NAMES.has(entry.name)) {
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (JOB_SKIP_EXTENSIONS.has(ext)) {
        continue;
      }

      const repoPath = `jobs/${jobId}/${rel.replace(/\\/g, "/")}`;
      if (isNeverTrackRepoPath(repoPath)) {
        continue;
      }
      if (entry.name === "job.json") {
        results.push({
          repoPath,
          fullPath: full,
          readContent: async () => readJobConfigJson(full),
        });
        continue;
      }

      results.push({ repoPath, fullPath: full });
    }
  }

  await walk(jobDir, "");
  return results.sort((a, b) => a.repoPath.localeCompare(b.repoPath));
}

async function readJobConfigJson(fullPath: string): Promise<string> {
  const raw = await fs.readFile(fullPath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const { config } = parseMonolithicJobJson(parsed);
  return `${JSON.stringify(config, null, 2)}\n`;
}

async function collectLinkedJobCandidates(
  paprDir: string,
  appId: string,
): Promise<WalkCandidate[]> {
  const jobIds = resolveAppDependentJobIds(paprDir, appId);
  const candidates: WalkCandidate[] = [];

  for (const jobId of jobIds) {
    const jobDir = path.join(paprDir, "Jobs", jobId);
    try {
      const stat = await fs.stat(jobDir);
      if (!stat.isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    candidates.push(...(await walkJobFiles(jobDir, jobId)));
  }

  return candidates;
}

async function readSchemaOwnerRecords(
  paprDir: string,
  appId: string,
): Promise<DatabaseRecord[]> {
  const registryPath = path.join(paprDir, "data", DATABASES_REGISTRY_FILENAME);
  try {
    const raw = await fs.readFile(registryPath, "utf8");
    const parsed = JSON.parse(raw) as DatabasesRegistryFile;
    return Object.values(parsed.databases ?? {}).filter(
      (record) =>
        record.status === "active" && record.schemaOwnerAppId === appId,
    );
  } catch {
    return [];
  }
}

async function collectSchemaOwnerMigrationCandidates(
  paprDir: string,
  appId: string,
): Promise<WalkCandidate[]> {
  const owned = await readSchemaOwnerRecords(paprDir, appId);
  const candidates: WalkCandidate[] = [];

  for (const record of owned) {
    const slug = registrySlugFromLocalPath(record.localPath);
    if (!slug) {
      continue;
    }
    const migrationsDir = path.join(
      paprDir,
      "data",
      "databases",
      slug,
      "migrations",
    );
    let entries: string[];
    try {
      entries = await fs.readdir(migrationsDir);
    } catch {
      continue;
    }

    for (const fileName of entries.sort()) {
      if (fileName.startsWith(".")) {
        continue;
      }
      const fullPath = path.join(migrationsDir, fileName);
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) {
        continue;
      }
      candidates.push({
        repoPath: `databases/${slug}/migrations/${fileName}`,
        fullPath,
      });
    }
  }

  return candidates;
}

type CandidateOutcome =
  | { kind: "op"; file: AppRepoOpFile; byteLength: number }
  | { kind: "unchanged" }
  | { kind: "rejected"; reason: string };

async function candidateToOpFile(
  candidate: WalkCandidate,
  cachedOids: Readonly<Record<string, string>>,
): Promise<CandidateOutcome> {
  let stat;
  try {
    stat = await fs.stat(candidate.fullPath);
  } catch {
    return { kind: "unchanged" };
  }
  if (!stat.isFile()) {
    return { kind: "unchanged" };
  }

  // Checked before the read, not after. The writer rejects oversized files
  // anyway, and reading one first only to discard it is how a single large
  // asset took down the process.
  if (!candidate.readContent && isTooLargeForGitSync(stat.size)) {
    return {
      kind: "rejected",
      reason: `over ${formatGitSyncSizeLimitMb()} — store it with App Files`,
    };
  }

  const content = candidate.readContent
    ? await candidate.readContent()
    : await fs.readFile(candidate.fullPath, "utf8");

  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength > MAX_GIT_SYNC_FILE_BYTES) {
    return {
      kind: "rejected",
      reason: `over ${formatGitSyncSizeLimitMb()} — store it with App Files`,
    };
  }

  const currentOid = await computeBlobOidForContent(content);
  const cachedOid = cachedOids[candidate.repoPath] ?? null;
  if (cachedOid === currentOid) {
    return { kind: "unchanged" };
  }

  return {
    kind: "op",
    byteLength,
    file: {
      path: candidate.repoPath,
      content,
      parentHash: cachedOid ?? "",
    },
  };
}

export interface CollectAppOpFilesResult {
  files: AppRepoOpFile[];
  rejected: Array<{ path: string; reason: string }>;
  skippedUnchanged: number;
  /** Changed files held back by the batch budget; sent on a later flush. */
  deferred: number;
}

/**
 * Build writer op files for an app folder plus linked jobs and schema-owner migrations.
 * Sends files whose current blob OID differs from OID cache (or cache miss).
 */
export async function collectAppOpFiles(
  paprDir: string,
  appId: string,
): Promise<CollectAppOpFilesResult> {
  const appDir = path.join(paprDir, "apps", appId);
  const repoPaths = await walkAppFiles(appDir);

  const candidates: WalkCandidate[] = repoPaths.map((repoPath) => ({
    repoPath,
    fullPath: path.join(appDir, repoPath),
  }));

  candidates.push(...(await collectLinkedJobCandidates(paprDir, appId)));
  candidates.push(
    ...(await collectSchemaOwnerMigrationCandidates(paprDir, appId)),
  );

  // Loaded once per flush. Reading it per file meant parsing the whole cache
  // several hundred times for one app.
  const cachedOids = (await readOidCache()).apps[appId] ?? {};

  const opCandidates: AppRepoOpFile[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  let skippedUnchanged = 0;
  let deferred = 0;
  let batchBytes = 0;

  for (const candidate of candidates) {
    if (batchBytes >= MAX_OP_BATCH_CONTENT_BYTES) {
      deferred += 1;
      continue;
    }

    const outcome = await candidateToOpFile(candidate, cachedOids);
    if (outcome.kind === "unchanged") {
      skippedUnchanged += 1;
      continue;
    }
    if (outcome.kind === "rejected") {
      skipped.push({ path: candidate.repoPath, reason: outcome.reason });
      continue;
    }

    opCandidates.push(outcome.file);
    batchBytes += outcome.byteLength;
  }

  if (deferred > 0) {
    console.warn(
      `[collectAppOpFiles] ${appId}: batch budget reached — sending ` +
        `${opCandidates.length} files, deferring ${deferred} to the next flush.`,
    );
  }

  const { accepted, rejected } = filterAbusiveOpFiles(opCandidates);
  return {
    files: accepted,
    rejected: [...skipped, ...rejected],
    skippedUnchanged,
    deferred,
  };
}

/** Files in an app folder that exceed the git sync size limit (local only — not uploaded). */
export async function listOversizedAppFiles(
  paprDir: string,
  appId: string,
): Promise<Array<{ path: string; sizeBytes: number; reason: string }>> {
  const appDir = path.join(paprDir, "apps", appId);
  return listOversizedFilesInAppDir(appDir);
}

/** Scan a mini-app directory for files that git sync will skip (oversized or never-track media). */
export async function listOversizedFilesInAppDir(
  appDir: string,
): Promise<Array<{ path: string; sizeBytes: number; reason: string }>> {
  const repoPaths = await walkAllAppFilesForReporting(appDir);
  const unsyncable: Array<{ path: string; sizeBytes: number; reason: string }> =
    [];

  for (const repoPath of repoPaths) {
    const fullPath = path.join(appDir, repoPath);
    try {
      const stat = await fs.stat(fullPath);
      if (!stat.isFile()) {
        continue;
      }
      if (isNeverTrackRepoPath(repoPath)) {
        unsyncable.push({
          path: repoPath,
          sizeBytes: stat.size,
          reason: "never tracked by git — use App Files",
        });
        continue;
      }
      if (isTooLargeForGitSync(stat.size)) {
        unsyncable.push({
          path: repoPath,
          sizeBytes: stat.size,
          reason: `over ${formatGitSyncSizeLimitMb()}`,
        });
      }
    } catch {
      // Missing or unreadable — skip
    }
  }

  return unsyncable;
}

async function walkAllAppFilesForReporting(appDir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(currentDir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) {
          continue;
        }
        await walk(full, rel);
        continue;
      }
      if (entry.isFile()) {
        results.push(rel.replace(/\\/g, "/"));
      }
    }
  }

  await walk(appDir, "");
  return results.sort();
}

/** Recompute parentHash from OID cache before outbox replay. */
export async function refreshOpParentHashes(
  appId: string,
  files: AppRepoOpFile[],
): Promise<AppRepoOpFile[]> {
  const cachedOids = (await readOidCache()).apps[appId] ?? {};
  const refreshed: AppRepoOpFile[] = [];
  for (const file of files) {
    const cachedOid = cachedOids[file.path] ?? null;
    const content = file.content;
    if (content !== null) {
      const oid = await computeBlobOidForContent(content);
      if (cachedOid === oid) {
        continue;
      }
    }
    refreshed.push({
      ...file,
      parentHash: cachedOid ?? "",
      content,
    });
  }
  return refreshed;
}

/** Local papr-relative paths covered by writer ops (for sync state marking). */
export async function resolveWriterSyncedLocalPaths(
  paprDir: string,
  appId: string,
): Promise<string[]> {
  const paths = [`apps/${appId}`];
  for (const jobId of resolveAppDependentJobIds(paprDir, appId)) {
    paths.push(path.join("Jobs", jobId));
  }

  for (const record of await readSchemaOwnerRecords(paprDir, appId)) {
    const slug = registrySlugFromLocalPath(record.localPath);
    if (slug) {
      paths.push(path.join("data", "databases", slug, "migrations"));
    }
  }

  return paths;
}
