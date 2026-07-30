/**
 * Scan jobs and apps for legacy flat ~/Papr paths and hardcoded path strings.
 * Used by Jobs/Apps pages to surface fix-with-agent actions.
 */

import { existsSync } from "fs";
import fs from "fs/promises";
import path from "path";
import type {
  AppLegacyPathHealth,
  JobLegacyPathHealth,
  LegacyPathHealthScanResult,
  LegacyPathIssue,
} from "../../core/types/legacyPathHealth.js";
import { getPaprBaseDir, readActiveWorkspacePointer } from "../../core/utils/paprWorkspace.js";
import { getPaprRoot } from "../../core/utils/paprRoot.js";
import {
  containsRepairablePaprPaths,
  rewritePortablePaprPaths,
} from "./jobs/rewritePortablePaprPaths.js";
import { parseDataSourcesFile,
  type AppDataSourcesFile,
} from "./appDataSources.js";
import type { JobRecord } from "./jobs/types.js";
import { getPaprDataDir } from "../../core/utils/paprRoot.js";
import {
  isFlatRegistryDbPath,
  isReadableDbFile,
  resolveReadableRegistryDbPath,
  workspaceRegistryDbPath,
  extractDatabaseSlugFromPath,
} from "./resolveRegistryDbPath.js";
import {
  buildAppFolderIndex,
  buildJobFolderIndex,
  formatIndexedLocation,
  type IndexedAppFolder,
  type IndexedJobFolder,
} from "./paprFolderIndex.js";
import { resolveAppDependentJobIds, jobRelativePath } from "./cloudSync/resolveAppDependentJobs.js";

const SOURCE_EXTENSIONS = new Set([
  ".py",
  ".js",
  ".ts",
  ".mjs",
  ".cjs",
  ".sh",
  ".html",
  ".tsx",
  ".jsx",
]);
const MAX_SOURCE_FILE_BYTES = 96 * 1024;
const MAX_SOURCE_FILES_PER_RESOURCE = 12;

function pathsEqual(a: string, b: string): boolean {
  return path.normalize(a) === path.normalize(b);
}

async function gitTracksRelativePath(
  workspaceHome: string,
  relativePath: string,
): Promise<boolean> {
  if (!existsSync(path.join(workspaceHome, ".git"))) {
    return false;
  }
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--", relativePath],
      { cwd: workspaceHome, timeout: 5000 },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

function pushMissingResourceIssues(input: {
  issues: LegacyPathIssue[];
  kind: "missing_job_folder" | "missing_app_folder" | "missing_linked_job_folder";
  summary: string;
  expectedPath: string;
  resourceId: string;
  elsewhere: IndexedJobFolder | IndexedAppFolder | undefined;
  activeHome: string;
  gitHint?: string;
}): void {
  pushIssue(input.issues, {
    kind: input.kind,
    summary: input.summary,
    detail: input.expectedPath,
  });

  if (
    input.elsewhere &&
    !pathsEqual(input.elsewhere.workspaceHome, input.activeHome)
  ) {
    const folderPath =
      "jobDir" in input.elsewhere
        ? input.elsewhere.jobDir
        : input.elsewhere.appPath;
    pushIssue(input.issues, {
      kind: "resource_found_elsewhere",
      summary: `Copy exists in ${formatIndexedLocation(input.elsewhere)}`,
      detail: folderPath,
    });
    return;
  }

  if (
    input.elsewhere &&
    pathsEqual(input.elsewhere.workspaceHome, input.activeHome)
  ) {
    return;
  }

  if (input.gitHint) {
    pushIssue(input.issues, {
      kind: "resource_found_elsewhere",
      summary: "May be recoverable from cloud sync git",
      detail: input.gitHint,
    });
  }
}

/** Resource lives under flat ~/Papr/{apps,Jobs,data,...} but not active namespace. */
export function isFlatLegacyResourcePath(
  resourcePath: string,
  paprBase: string,
  activeHome: string,
): boolean {
  const resource = path.normalize(path.resolve(resourcePath));
  const base = path.normalize(path.resolve(paprBase));
  const home = path.normalize(path.resolve(activeHome));

  if (resource === home || resource.startsWith(`${home}${path.sep}`)) {
    return false;
  }

  const flatRoots = ["apps", "Jobs", "jobs", "data", "documents", "workspace"];
  for (const segment of flatRoots) {
    const flatRoot = path.join(base, segment);
    if (resource === flatRoot || resource.startsWith(`${flatRoot}${path.sep}`)) {
      return true;
    }
  }

  return false;
}

function pushIssue(
  issues: LegacyPathIssue[],
  issue: LegacyPathIssue,
): void {
  const duplicate = issues.some(
    (entry) => entry.kind === issue.kind && entry.summary === issue.summary,
  );
  if (!duplicate) {
    issues.push(issue);
  }
}

async function collectSourceFiles(rootDir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (out.length >= MAX_SOURCE_FILES_PER_RESOURCE) {
      return;
    }
    if (
      entry.name === "node_modules" ||
      entry.name === "venv" ||
      entry.name === ".venv" ||
      entry.name === "dist" ||
      entry.name === "chrome-profile"
    ) {
      continue;
    }

    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      await collectSourceFiles(fullPath, out);
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(ext)) {
      continue;
    }
    if (entry.name === "data-sources.json" || entry.name === "package-lock.json") {
      continue;
    }
    out.push(fullPath);
  }
}

async function scanTextFileForLegacyPaths(
  filePath: string,
  jobId: string | undefined,
  issues: LegacyPathIssue[],
): Promise<void> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || stat.size > MAX_SOURCE_FILE_BYTES) {
    return;
  }

  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return;
  }

  if (!containsRepairablePaprPaths(content)) {
    return;
  }

  const { changed } = rewritePortablePaprPaths(content, jobId);
  if (!changed) {
    return;
  }

  pushIssue(issues, {
    kind: "hardcoded_source_path",
    summary: `Hardcoded Papr path in ${path.basename(filePath)}`,
    detail: filePath,
    filePath,
  });
}

function scanJobCommandFields(job: JobRecord, issues: LegacyPathIssue[]): void {
  const fields: Array<{ key: string; value?: string }> = [
    { key: "command", value: job.command },
    { key: "delegationTask", value: job.delegationTask },
    { key: "delegationContext", value: job.delegationContext },
  ];

  for (const field of fields) {
    if (!field.value || !containsRepairablePaprPaths(field.value)) {
      continue;
    }
    const { changed } = rewritePortablePaprPaths(field.value, job.id);
    if (!changed) {
      continue;
    }
    pushIssue(issues, {
      kind: "hardcoded_command_path",
      summary: `Hardcoded Papr path in job ${field.key}`,
      detail: field.value.length > 160 ? `${field.value.slice(0, 160)}…` : field.value,
    });
  }
}

async function scanJobLegacyPaths(input: {
  job: JobRecord;
  jobDir: string;
  paprBase: string;
  activeHome: string;
}): Promise<JobLegacyPathHealth | null> {
  const issues: LegacyPathIssue[] = [];

  if (isFlatLegacyResourcePath(input.jobDir, input.paprBase, input.activeHome)) {
    pushIssue(issues, {
      kind: "flat_legacy_location",
      summary: "Job folder is under flat ~/Papr instead of your active workspace",
      detail: input.jobDir,
    });
  }

  scanJobCommandFields(input.job, issues);

  const codeDir = path.join(input.jobDir, "code");
  const sourceFiles: string[] = [];
  await collectSourceFiles(codeDir, sourceFiles);
  for (const filePath of sourceFiles) {
    await scanTextFileForLegacyPaths(filePath, input.job.id, issues);
  }

  if (issues.length === 0) {
    return null;
  }

  return {
    jobId: input.job.id,
    jobName: input.job.name,
    jobDir: input.jobDir,
    issues,
  };
}

async function scanAppDataSources(input: {
  appId: string;
  appPath: string;
  jobFolderIndex: Map<string, IndexedJobFolder>;
  jobsRoot: string;
  activeHome: string;
  paprBase: string;
  issues: LegacyPathIssue[];
}): Promise<void> {
  const dataSourcesPath = path.join(input.appPath, "data-sources.json");
  if (!existsSync(dataSourcesPath)) {
    return;
  }

  let config: AppDataSourcesFile;
  try {
    const raw = await fs.readFile(dataSourcesPath, "utf8");
    config = parseDataSourcesFile(raw);
  } catch {
    return;
  }

  const dataDir = getPaprDataDir();

  let registry: { getById: (dbId: string) => { localPath: string } | undefined };
  try {
    const { getDatabaseRegistryService } = await import(
      "./DatabaseRegistryService.js"
    );
    registry = getDatabaseRegistryService();
  } catch {
    registry = { getById: () => undefined };
  }

  for (const source of config.sources ?? []) {
    if (!source.jobId) {
      const stored = source.dbPath?.trim() ?? "";
      const record = source.dbId ? registry.getById(source.dbId) : undefined;
      const readable = resolveReadableRegistryDbPath({
        dbPath: source.dbPath,
        registryPath: record?.localPath,
        dataDir,
      });

      if (stored.length > 0 && !readable) {
        pushIssue(input.issues, {
          kind: "stale_data_source_db_path",
          summary: `Database file missing for data source "${source.alias}"`,
          detail: stored,
          filePath: dataSourcesPath,
        });
        continue;
      }

      if (readable && stored.length > 0 && !pathsEqual(stored, readable)) {
        pushIssue(input.issues, {
          kind: "stale_data_source_db_path",
          summary: `Stale dbPath for data source "${source.alias}"`,
          detail: `${stored} → should be ${readable}`,
          filePath: dataSourcesPath,
        });
        continue;
      }

      if (
        stored.length > 0 &&
        isFlatRegistryDbPath(stored, input.paprBase)
      ) {
        const slug = extractDatabaseSlugFromPath(stored);
        const workspacePath = slug
          ? workspaceRegistryDbPath(slug, dataDir)
          : null;
        if (workspacePath && isReadableDbFile(workspacePath)) {
          pushIssue(input.issues, {
            kind: "stale_data_source_db_path",
            summary: `Stale dbPath for data source "${source.alias}"`,
            detail: `${stored} → should be ${workspacePath}`,
            filePath: dataSourcesPath,
          });
        }
      }
      continue;
    }

    const jobFolderExists = existsSync(path.join(input.jobsRoot, source.jobId));

    if (!jobFolderExists) {
      const elsewhere = input.jobFolderIndex.get(source.jobId);
      pushMissingResourceIssues({
        issues: input.issues,
        kind: "missing_linked_job_folder",
        summary: `Linked job folder missing for data source "${source.alias}" (job ${source.jobId})`,
        expectedPath: path.join(input.jobsRoot, source.jobId),
        resourceId: source.jobId,
        elsewhere,
        activeHome: input.activeHome,
        gitHint: `git checkout -- ${jobRelativePath(source.jobId)}/ (if tracked in cloud sync)`,
      });
      continue;
    }

    // Job-linked sources resolve from active workspace Jobs/ at runtime when the
    // local database exists — cross-namespace stored paths are not user-facing issues.
  }
}

async function scanAppLinkedJobs(input: {
  appId: string;
  activeHome: string;
  jobsRoot: string;
  jobFolderIndex: Map<string, IndexedJobFolder>;
  jobsById: Map<string, JobRecord>;
  issues: LegacyPathIssue[];
}): Promise<void> {
  const linkedJobIds = resolveAppDependentJobIds(input.activeHome, input.appId);
  const reported = new Set<string>();

  for (const jobId of linkedJobIds) {
    if (reported.has(jobId)) continue;
    reported.add(jobId);

    const expectedDir = path.join(input.jobsRoot, jobId);
    if (existsSync(expectedDir)) {
      continue;
    }

    const jobName = input.jobsById.get(jobId)?.name ?? jobId;
    const elsewhere = input.jobFolderIndex.get(jobId);
    let gitHint: string | undefined;
    if (!elsewhere) {
      const inGit = await gitTracksRelativePath(
        input.activeHome,
        jobRelativePath(jobId),
      );
      if (inGit) {
        gitHint = `Run \`git checkout -- ${jobRelativePath(jobId)}/\` in ${input.activeHome}`;
      }
    }

    pushMissingResourceIssues({
      issues: input.issues,
      kind: "missing_linked_job_folder",
      summary: `App-linked job "${jobName}" folder missing (id: ${jobId})`,
      expectedPath: expectedDir,
      resourceId: jobId,
      elsewhere,
      activeHome: input.activeHome,
      gitHint,
    });
  }
}

async function scanAppLegacyPaths(input: {
  appId: string;
  appTitle: string;
  appPath: string;
  paprBase: string;
  activeHome: string;
  jobsRoot: string;
  jobFolderIndex: Map<string, IndexedJobFolder>;
  appFolderIndex: Map<string, IndexedAppFolder>;
  jobsById: Map<string, JobRecord>;
}): Promise<AppLegacyPathHealth | null> {
  const issues: LegacyPathIssue[] = [];

  if (!existsSync(input.appPath)) {
    const elsewhere = input.appFolderIndex.get(input.appId);
    let gitHint: string | undefined;
    if (!elsewhere) {
      const inGit = await gitTracksRelativePath(
        input.activeHome,
        path.join("apps", input.appId),
      );
      if (inGit) {
        gitHint = `Run \`git checkout -- apps/${input.appId}/\` in ${input.activeHome}`;
      }
    }
    pushMissingResourceIssues({
      issues,
      kind: "missing_app_folder",
      summary: `Mini-app "${input.appTitle}" folder missing from active workspace`,
      expectedPath: input.appPath,
      resourceId: input.appId,
      elsewhere,
      activeHome: input.activeHome,
      gitHint,
    });
    return {
      appId: input.appId,
      appTitle: input.appTitle,
      appPath: input.appPath,
      issues,
    };
  }

  if (isFlatLegacyResourcePath(input.appPath, input.paprBase, input.activeHome)) {
    pushIssue(issues, {
      kind: "flat_legacy_location",
      summary: "App files live under flat ~/Papr instead of your active workspace",
      detail: input.appPath,
    });
  }

  await scanAppDataSources({
    appId: input.appId,
    appPath: input.appPath,
    jobFolderIndex: input.jobFolderIndex,
    jobsRoot: input.jobsRoot,
    activeHome: input.activeHome,
    paprBase: input.paprBase,
    issues,
  });

  await scanAppLinkedJobs({
    appId: input.appId,
    activeHome: input.activeHome,
    jobsRoot: input.jobsRoot,
    jobFolderIndex: input.jobFolderIndex,
    jobsById: input.jobsById,
    issues,
  });

  const sourceFiles: string[] = [];
  await collectSourceFiles(input.appPath, sourceFiles);
  for (const filePath of sourceFiles) {
    await scanTextFileForLegacyPaths(filePath, undefined, issues);
  }

  if (issues.length === 0) {
    return null;
  }

  return {
    appId: input.appId,
    appTitle: input.appTitle,
    appPath: input.appPath,
    issues,
  };
}

export async function scanLegacyPathHealth(input: {
  jobs: JobRecord[];
  apps: Array<{ id: string; title: string }>;
  jobsRoot: string;
  appsRoot: string;
  paprBase?: string;
  activePaprHome?: string;
}): Promise<LegacyPathHealthScanResult> {
  const paprBase = input.paprBase ?? getPaprBaseDir();
  const pointer = readActiveWorkspacePointer();
  const activePaprHome = input.activePaprHome ?? pointer?.paprHome ?? getPaprRoot();
  const [jobFolderIndex, appFolderIndex] = await Promise.all([
    buildJobFolderIndex(paprBase),
    buildAppFolderIndex(paprBase),
  ]);
  const jobsById = new Map(input.jobs.map((job) => [job.id, job]));

  const jobResults: JobLegacyPathHealth[] = [];
  for (const job of input.jobs) {
    const jobDir = path.join(input.jobsRoot, job.id);
    if (!existsSync(jobDir)) {
      const elsewhere = jobFolderIndex.get(job.id);
      let gitHint: string | undefined;
      if (!elsewhere) {
        const inGit = await gitTracksRelativePath(
          activePaprHome,
          jobRelativePath(job.id),
        );
        if (inGit) {
          gitHint = `Run \`git checkout -- ${jobRelativePath(job.id)}/\` in ${activePaprHome}`;
        }
      }
      const issues: LegacyPathIssue[] = [];
      pushMissingResourceIssues({
        issues,
        kind: "missing_job_folder",
        summary: `Job "${job.name}" folder missing from active workspace`,
        expectedPath: jobDir,
        resourceId: job.id,
        elsewhere,
        activeHome: activePaprHome,
        gitHint,
      });
      if (issues.length > 0) {
        jobResults.push({
          jobId: job.id,
          jobName: job.name,
          jobDir,
          issues,
        });
      }
      continue;
    }
    const result = await scanJobLegacyPaths({
      job,
      jobDir,
      paprBase,
      activeHome: activePaprHome,
    });
    if (result) {
      jobResults.push(result);
    }
  }

  const appResults: AppLegacyPathHealth[] = [];
  for (const app of input.apps) {
    const appPath = path.join(input.appsRoot, app.id);
    const result = await scanAppLegacyPaths({
      appId: app.id,
      appTitle: app.title,
      appPath,
      paprBase,
      activeHome: activePaprHome,
      jobsRoot: input.jobsRoot,
      jobFolderIndex,
      appFolderIndex,
      jobsById,
    });
    if (result) {
      appResults.push(result);
    }
  }

  return {
    scannedAt: new Date().toISOString(),
    activePaprHome,
    jobs: jobResults,
    apps: appResults,
    jobIssueCount: jobResults.length,
    appIssueCount: appResults.length,
  };
}
