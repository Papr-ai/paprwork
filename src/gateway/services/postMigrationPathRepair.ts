/**
 * Offline repair for hardcoded Papr paths after flat → namespace migration.
 *
 * Phases:
 * 1. data-sources.json dbPath (jobId-based, existing repair)
 * 2. jobs.json command fields
 * 3. Job source files under Jobs/{id}/code/
 * 4. Mini-app source (optional, conservative path rewrites only)
 */

import { existsSync, type Dirent } from "fs";
import fs from "fs/promises";
import path from "path";
import { getPaprBaseDir } from "../../core/utils/paprWorkspace.js";
import type { JobRecord } from "./jobs/types.js";
import {
  containsRepairablePaprPaths,
  rewritePortablePaprPaths,
} from "./jobs/rewritePortablePaprPaths.js";
import {
  runGlobalDataSourcePathRepair,
  type DataSourcePathRepairScanResult,
} from "./dataSourcePathRepairScan.js";

const SKIP_DIR_NAMES = new Set([
  "venv",
  ".venv",
  "node_modules",
  "__pycache__",
  ".git",
  "logs",
  "evaluations",
  "dist",
]);

const JOB_CODE_EXTENSIONS = new Set([
  ".py",
  ".js",
  ".ts",
  ".mjs",
  ".cjs",
  ".sh",
  ".bash",
  ".sql",
]);

const APP_SOURCE_EXTENSIONS = new Set([
  ".html",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".css",
  ".json",
]);

const MAX_TEXT_FILE_BYTES = 512 * 1024;

export interface PostMigrationPathRepairOptions {
  paprBase?: string;
  dryRun?: boolean;
  /** Repair mini-app source files (index.html, app.js, etc.). Default true. */
  includeApps?: boolean;
  delayMs?: number;
  /** Limit scan/repair to one workspace papr home (faster after consent migration). */
  scopePaprHome?: string;
}

export interface TextFileRepairEntry {
  filePath: string;
  jobId?: string;
  field?: string;
}

export interface PostMigrationPathRepairResult {
  dryRun: boolean;
  dataSources: DataSourcePathRepairScanResult;
  jobsJson: {
    scannedFiles: number;
    repairedFiles: number;
    repairedJobs: number;
    repairs: Array<{
      jobsJsonPath: string;
      jobId: string;
      jobName: string;
      field: string;
      from: string;
      to: string;
    }>;
  };
  jobCode: {
    scannedFiles: number;
    repairedFiles: number;
    repairs: TextFileRepairEntry[];
  };
  appSource: {
    scannedFiles: number;
    repairedFiles: number;
    repairs: TextFileRepairEntry[];
  };
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function discoverJobsJsonFiles(
  paprBase: string,
  scopePaprHome?: string,
): Promise<string[]> {
  if (scopePaprHome) {
    const scopedPath = path.join(scopePaprHome, "data", "jobs.json");
    return existsSync(scopedPath) ? [scopedPath] : [];
  }

  const files: string[] = [];

  const flatPath = path.join(paprBase, "data", "jobs.json");
  if (existsSync(flatPath)) {
    files.push(flatPath);
  }

  const orgsDir = path.join(paprBase, "orgs");
  let orgIds: string[];
  try {
    orgIds = await fs.readdir(orgsDir);
  } catch {
    return files;
  }

  for (const orgId of orgIds) {
    const namespacesDir = path.join(orgsDir, orgId, "namespaces");
    let namespaceIds: string[];
    try {
      namespaceIds = await fs.readdir(namespacesDir);
    } catch {
      continue;
    }

    for (const namespaceId of namespaceIds) {
      const jobsJsonPath = path.join(
        namespacesDir,
        namespaceId,
        "data",
        "jobs.json",
      );
      if (existsSync(jobsJsonPath)) {
        files.push(jobsJsonPath);
      }
    }
  }

  return files;
}

async function repairJobsJsonFiles(
  jobsJsonPaths: string[],
  options: { dryRun: boolean; delayMs: number },
): Promise<PostMigrationPathRepairResult["jobsJson"]> {
  const result: PostMigrationPathRepairResult["jobsJson"] = {
    scannedFiles: jobsJsonPaths.length,
    repairedFiles: 0,
    repairedJobs: 0,
    repairs: [],
  };

  for (const jobsJsonPath of jobsJsonPaths) {
    let raw: string;
    try {
      raw = await fs.readFile(jobsJsonPath, "utf8");
    } catch {
      await delay(options.delayMs);
      continue;
    }

    let jobs: JobRecord[];
    try {
      jobs = JSON.parse(raw) as JobRecord[];
    } catch {
      console.warn(
        `[repair:post-migration] Skipping ${jobsJsonPath}: invalid JSON`,
      );
      await delay(options.delayMs);
      continue;
    }

    if (!Array.isArray(jobs)) {
      await delay(options.delayMs);
      continue;
    }

    let fileChanged = false;
    const updatedJobs: JobRecord[] = [];

    for (const job of jobs) {
      const fieldsToCheck: Array<keyof JobRecord> = [
        "command",
        "delegationTask",
        "delegationContext",
      ];
      let jobChanged = false;
      const updatedJob = { ...job };

      for (const field of fieldsToCheck) {
        const value = job[field];
        if (typeof value !== "string" || !containsRepairablePaprPaths(value)) {
          continue;
        }

        const { text: rewritten, changed } = rewritePortablePaprPaths(
          value,
          job.id,
        );
        if (!changed) {
          continue;
        }

        Object.assign(updatedJob, { [field]: rewritten });
        jobChanged = true;
        fileChanged = true;
        result.repairs.push({
          jobsJsonPath,
          jobId: job.id,
          jobName: job.name,
          field,
          from: value.length > 120 ? `${value.slice(0, 120)}…` : value,
          to: rewritten.length > 120 ? `${rewritten.slice(0, 120)}…` : rewritten,
        });
        console.log(
          `[repair:post-migration] ${options.dryRun ? "(dry-run) " : ""}` +
            `jobs.json ${job.name} (${job.id}) ${field}: portable paths updated`,
        );
      }

      updatedJobs.push(jobChanged ? updatedJob : job);
      if (jobChanged) {
        result.repairedJobs += 1;
      }
    }

    if (fileChanged) {
      result.repairedFiles += 1;
      if (!options.dryRun) {
        await fs.writeFile(
          jobsJsonPath,
          `${JSON.stringify(updatedJobs, null, 2)}\n`,
          "utf8",
        );
      }
    }

    await delay(options.delayMs);
  }

  return result;
}

async function collectTextFiles(
  rootDir: string,
  extensions: Set<string>,
  out: string[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      await collectTextFiles(fullPath, extensions, out);
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (!extensions.has(ext)) {
      continue;
    }

    if (entry.name === "data-sources.json" || entry.name === "package-lock.json") {
      continue;
    }

    out.push(fullPath);
  }
}

async function discoverJobCodeFiles(
  paprBase: string,
  scopePaprHome?: string,
): Promise<Array<{ filePath: string; jobId: string }>> {
  const files: Array<{ filePath: string; jobId: string }> = [];

  async function indexJobsRoot(jobsRoot: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(jobsRoot, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const codeDir = path.join(jobsRoot, entry.name, "code");
      const paths: string[] = [];
      await collectTextFiles(codeDir, JOB_CODE_EXTENSIONS, paths);
      for (const filePath of paths) {
        files.push({ filePath, jobId: entry.name });
      }
    }
  }

  if (scopePaprHome) {
    await indexJobsRoot(path.join(scopePaprHome, "Jobs"));
    const lowerJobsRoot = path.join(scopePaprHome, "jobs");
    if (existsSync(lowerJobsRoot)) {
      await indexJobsRoot(lowerJobsRoot);
    }
    return files;
  }

  await indexJobsRoot(path.join(paprBase, "Jobs"));
  const lowerJobsRoot = path.join(paprBase, "jobs");
  if (existsSync(lowerJobsRoot)) {
    await indexJobsRoot(lowerJobsRoot);
  }

  const orgsDir = path.join(paprBase, "orgs");
  let orgIds: string[];
  try {
    orgIds = await fs.readdir(orgsDir);
  } catch {
    return files;
  }

  for (const orgId of orgIds) {
    const namespacesDir = path.join(orgsDir, orgId, "namespaces");
    let namespaceIds: string[];
    try {
      namespaceIds = await fs.readdir(namespacesDir);
    } catch {
      continue;
    }

    for (const namespaceId of namespaceIds) {
      await indexJobsRoot(
        path.join(namespacesDir, namespaceId, "Jobs"),
      );
    }
  }

  return files;
}

async function discoverAppSourceFiles(
  paprBase: string,
  scopePaprHome?: string,
): Promise<string[]> {
  const files: string[] = [];

  async function indexAppsRoot(appsRoot: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(appsRoot, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      await collectTextFiles(
        path.join(appsRoot, entry.name),
        APP_SOURCE_EXTENSIONS,
        files,
      );
    }
  }

  if (scopePaprHome) {
    await indexAppsRoot(path.join(scopePaprHome, "apps"));
    return files;
  }

  await indexAppsRoot(path.join(paprBase, "apps"));

  const orgsDir = path.join(paprBase, "orgs");
  let orgIds: string[];
  try {
    orgIds = await fs.readdir(orgsDir);
  } catch {
    return files;
  }

  for (const orgId of orgIds) {
    const namespacesDir = path.join(orgsDir, orgId, "namespaces");
    let namespaceIds: string[];
    try {
      namespaceIds = await fs.readdir(namespacesDir);
    } catch {
      continue;
    }

    for (const namespaceId of namespaceIds) {
      await indexAppsRoot(
        path.join(namespacesDir, namespaceId, "apps"),
      );
    }
  }

  return files;
}

async function repairTextFiles(
  entries: Array<{ filePath: string; jobId?: string }>,
  options: { dryRun: boolean; delayMs: number; label: string },
): Promise<{
  scannedFiles: number;
  repairedFiles: number;
  repairs: TextFileRepairEntry[];
}> {
  const result = {
    scannedFiles: entries.length,
    repairedFiles: 0,
    repairs: [] as TextFileRepairEntry[],
  };

  for (const entry of entries) {
    const stat = await fs.stat(entry.filePath).catch(() => null);
    if (!stat || stat.size > MAX_TEXT_FILE_BYTES) {
      await delay(options.delayMs);
      continue;
    }

    let content: string;
    try {
      content = await fs.readFile(entry.filePath, "utf8");
    } catch {
      await delay(options.delayMs);
      continue;
    }

    if (!containsRepairablePaprPaths(content)) {
      await delay(options.delayMs);
      continue;
    }

    const { text: rewritten, changed } = rewritePortablePaprPaths(
      content,
      entry.jobId,
    );
    if (!changed) {
      await delay(options.delayMs);
      continue;
    }

    result.repairedFiles += 1;
    result.repairs.push({
      filePath: entry.filePath,
      jobId: entry.jobId,
    });
    console.log(
      `[repair:post-migration] ${options.dryRun ? "(dry-run) " : ""}` +
        `${options.label} ${entry.filePath}`,
    );

    if (!options.dryRun) {
      await fs.writeFile(entry.filePath, rewritten, "utf8");
    }

    await delay(options.delayMs);
  }

  return result;
}

export async function runPostMigrationPathRepair(
  options: PostMigrationPathRepairOptions = {},
): Promise<PostMigrationPathRepairResult> {
  const paprBase = options.paprBase ?? getPaprBaseDir();
  const dryRun = options.dryRun ?? false;
  const includeApps = options.includeApps ?? true;
  const delayMs = options.delayMs ?? 15;
  const scopePaprHome = options.scopePaprHome;

  console.log(
    `[repair:post-migration] Starting${dryRun ? " (dry-run)" : ""} under ${paprBase}` +
      (scopePaprHome ? ` (scoped to ${scopePaprHome})` : ""),
  );

  const dataSources = await runGlobalDataSourcePathRepair({
    paprBase,
    dryRun,
    delayMs,
    scopePaprHome,
  });

  const jobsJsonPaths = await discoverJobsJsonFiles(paprBase, scopePaprHome);
  const jobsJson = await repairJobsJsonFiles(jobsJsonPaths, { dryRun, delayMs });

  const jobCodeEntries = await discoverJobCodeFiles(paprBase, scopePaprHome);
  const jobCode = await repairTextFiles(jobCodeEntries, {
    dryRun,
    delayMs,
    label: "job code",
  });

  let appSource: PostMigrationPathRepairResult["appSource"] = {
    scannedFiles: 0,
    repairedFiles: 0,
    repairs: [],
  };

  if (includeApps) {
    const appFiles = await discoverAppSourceFiles(paprBase, scopePaprHome);
    appSource = await repairTextFiles(
      appFiles.map((filePath) => ({ filePath })),
      { dryRun, delayMs, label: "app source" },
    );
  }

  return {
    dryRun,
    dataSources,
    jobsJson,
    jobCode,
    appSource,
  };
}

export function formatPostMigrationRepairSummary(
  result: PostMigrationPathRepairResult,
): string {
  const parts = [
    `data-sources: ${result.dataSources.repairCount} path(s) in ${result.dataSources.repairedApps} app(s)`,
    `jobs.json: ${result.jobsJson.repairedJobs} job(s) in ${result.jobsJson.repairedFiles} file(s)`,
    `job code: ${result.jobCode.repairedFiles}/${result.jobCode.scannedFiles} file(s)`,
    `app source: ${result.appSource.repairedFiles}/${result.appSource.scannedFiles} file(s)`,
  ];
  return parts.join("; ");
}
