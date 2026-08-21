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
import { filterAbusiveOpFiles } from "../appRepoWriter/abuseFilter.js";
import { resolveAppDependentJobIds } from "../cloudSync/resolveAppDependentJobs.js";
import {
  DATABASES_REGISTRY_FILENAME,
  type DatabaseRecord,
  type DatabasesRegistryFile,
  registrySlugFromLocalPath,
} from "../DatabaseRegistryService.js";
import { parseMonolithicJobJson } from "../jobs/jobRuntimeFields.js";
import { computeBlobOidForContent } from "./computeParentHash.js";
import { getCachedBlobOid } from "./OidCache.js";

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist-demo",
  "__pycache__",
  ".venv",
  "venv",
]);

const JOB_SKIP_DIR_NAMES = new Set([
  ...SKIP_DIR_NAMES,
  "data",
  "logs",
]);

const JOB_SKIP_FILE_NAMES = new Set(["job.runtime.json"]);

const JOB_SKIP_EXTENSIONS = new Set([".db", ".pyc", ".log", ".wal", ".shm"]);

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

async function walkJobFiles(jobDir: string, jobId: string): Promise<WalkCandidate[]> {
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

async function candidateToOpFile(
  appId: string,
  candidate: WalkCandidate,
): Promise<AppRepoOpFile | null> {
  let stat;
  try {
    stat = await fs.stat(candidate.fullPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) {
    return null;
  }

  const content = candidate.readContent
    ? await candidate.readContent()
    : await fs.readFile(candidate.fullPath, "utf8");
  const currentOid = await computeBlobOidForContent(content);
  const cachedOid = await getCachedBlobOid(appId, candidate.repoPath);
  if (cachedOid === currentOid) {
    return null;
  }

  return {
    path: candidate.repoPath,
    content,
    parentHash: cachedOid ?? "",
  };
}

export interface CollectAppOpFilesResult {
  files: AppRepoOpFile[];
  rejected: Array<{ path: string; reason: string }>;
  skippedUnchanged: number;
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
  candidates.push(...(await collectSchemaOwnerMigrationCandidates(paprDir, appId)));

  const opCandidates: AppRepoOpFile[] = [];
  let skippedUnchanged = 0;

  for (const candidate of candidates) {
    const opFile = await candidateToOpFile(appId, candidate);
    if (!opFile) {
      skippedUnchanged += 1;
      continue;
    }
    opCandidates.push(opFile);
  }

  const { accepted, rejected } = filterAbusiveOpFiles(opCandidates);
  return { files: accepted, rejected, skippedUnchanged };
}

/** Recompute parentHash from OID cache before outbox replay. */
export async function refreshOpParentHashes(
  appId: string,
  files: AppRepoOpFile[],
): Promise<AppRepoOpFile[]> {
  const refreshed: AppRepoOpFile[] = [];
  for (const file of files) {
    const cachedOid = await getCachedBlobOid(appId, file.path);
    let content = file.content;
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
