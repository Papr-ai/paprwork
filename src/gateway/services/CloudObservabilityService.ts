/**
 * Cloud observability for agent debugging — GitHub sync, Turso replicas,
 * published app runtime, and desktop heartbeat / pending cloud job runs.
 */

import { createClient } from "@libsql/client";
import * as fs from "fs";
import * as path from "path";
import { buildCloudReposRequestBody } from "../../core/utils/cloudReposScope.js";
import { getPaprAppsRoot, getPaprRoot } from "../../core/utils/paprRoot.js";
import { cloudApiFetch } from "../utils/cloudApiClient.js";
import { getPaprApiKey } from "../utils/keyResolver.js";
import { getCloudRuntimeClient } from "../utils/cloudRuntimeClient.js";
import type { PendingCloudRunNotification } from "../types/cloudRuntime.js";
import { getCloudSyncService } from "./CloudSyncService.js";
import {
  resolveAppDependentJobIds,
  readDataSourceRegistryDbIds,
} from "./cloudSync/resolveAppDependentJobs.js";
import { GitRunner } from "./cloudSync/gitRunner.js";
import { buildCloudLinkSyncReport } from "./cloudPublishStatus.js";
import { getJobsService } from "./JobsService.js";
import { getTursoSyncBridge } from "./TursoSyncBridge.js";
import type { TursoPushScopedResult } from "./TursoSyncBridge.js";
import type { PushGitScopedResult } from "./CloudSyncService.js";
import {
  buildTursoSyncItemsReport,
  type TursoSyncItemsReport,
} from "./tursoSyncStatus.js";
import {
  discoverTursoLinkedSources,
  resolveTursoDatabaseLabel,
} from "./tursoLinkedSources.js";
import { jobTursoDatabaseName } from "./tursoDatabaseNaming.js";
import type { GitHubSyncItemsReport } from "./cloudSync/syncItemStatus.js";

const DEFAULT_MAX_ROWS = 50;
const MAX_ROWS_CAP = 200;
const DEFAULT_REPO_FILE_CHARS = 12_000;
const DEFAULT_LOG_TAIL_LINES = 80;

export interface CloudSyncStatusReport {
  enabled: boolean;
  reason?: string;
  syncState: ReturnType<NonNullable<ReturnType<typeof getCloudSyncService>>["getState"]> | null;
  github: GitHubSyncItemsReport | null;
  turso: TursoSyncItemsReport | null;
  cloudLinks: Awaited<ReturnType<typeof buildCloudLinkSyncReport>> | null;
  desktopHeartbeat: {
    desktopAwake: boolean;
    recordedAt: string;
    staleAfterSeconds: number;
    pendingCloudRuns: PendingCloudRunNotification[];
  } | null;
  jobs: {
    local: Array<{
      id: string;
      name: string;
      type: string;
      status: string;
      lastRunAt?: string;
      completedAt?: string;
      error?: string | null;
      logTail?: string;
    }>;
    githubRecords: Array<{
      jobId: string;
      relativePath: string;
      found: boolean;
      record?: Record<string, unknown>;
    }>;
  };
  appContext?: {
    appId: string;
    dependentJobIds: string[];
    registryDbIds: string[];
  };
  checkedAt: string;
}

export interface CloudTursoQueryResult {
  tursoDatabase: string;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

function filterGitHubReportByApp(
  report: GitHubSyncItemsReport,
  appId: string,
  paprDir: string,
): GitHubSyncItemsReport {
  const dependentJobIds = new Set(resolveAppDependentJobIds(paprDir, appId));
  const filterItems = (items: GitHubSyncItemsReport["apps"]) =>
    items.filter(
      (item) =>
        item.id === appId ||
        item.relativePath === path.join("apps", appId) ||
        dependentJobIds.has(item.id) ||
        [...dependentJobIds].some((jobId) =>
          item.relativePath.startsWith(path.join("Jobs", jobId)),
        ),
    );

  const apps = filterItems(report.apps);
  const jobs = report.jobs.filter(
    (item) =>
      dependentJobIds.has(item.id) ||
      [...dependentJobIds].some((jobId) =>
        item.relativePath.startsWith(path.join("Jobs", jobId)),
      ),
  );

  const summarize = (
    items: Array<{ status: string }>,
  ): GitHubSyncItemsReport["summary"] => {
    let synced = 0;
    let pending = 0;
    let outdated = 0;
    let failed = 0;
    let updatesAvailable = 0;
    for (const item of items) {
      if (item.status === "synced") synced += 1;
      else if (item.status === "pending") pending += 1;
      else if (item.status === "outdated") outdated += 1;
      else if (item.status === "failed") failed += 1;
      else if (item.status === "updates_available") updatesAvailable += 1;
    }
    return {
      synced,
      pending,
      outdated,
      failed,
      updatesAvailable,
      total: items.length,
    };
  };

  const combined = [...apps, ...jobs];
  return {
    ...report,
    apps,
    jobs,
    workspace: [],
    summary: summarize(combined),
  };
}

async function requirePaprApiKey(): Promise<string> {
  const apiKey = await getPaprApiKey();
  if (!apiKey) {
    throw new Error(
      "Papr login required. Sign in under Settings → Papr Account to inspect cloud state.",
    );
  }
  return apiKey;
}

interface RepoTokenResponse {
  token: string;
  repos: Array<{ scope: string; cloneUrl: string }>;
}

async function fetchGitHubRepoToken(): Promise<{ token: string; owner: string; repo: string }> {
  await requirePaprApiKey();
  const resp = await cloudApiFetch("/v1/cloud/repos/token", {
    method: "POST",
    body: buildCloudReposRequestBody("user"),
    timeoutMs: 60_000,
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`GitHub repo token failed (${resp.status}): ${body.slice(0, 200)}`);
  }
  const data = (await resp.json()) as RepoTokenResponse;
  const userRepo = data.repos.find((entry) => entry.scope === "user") ?? data.repos[0];
  if (!userRepo?.cloneUrl) {
    throw new Error("GitHub repo token response missing user cloneUrl.");
  }
  const pathPart = userRepo.cloneUrl
    .replace(/^https:\/\/[^/]+@github\.com\//, "")
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "");
  const [owner, repo] = pathPart.split("/");
  if (!owner || !repo) {
    throw new Error("Could not parse GitHub owner/repo from clone URL.");
  }
  return { token: data.token, owner, repo };
}

async function readGitHubRepoFile(relativePath: string): Promise<string> {
  const normalized = relativePath.trim().replace(/^\/+/, "");
  const { token, owner, repo } = await fetchGitHubRepoToken();
  const encodedPath = normalized
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (response.status === 404) {
    throw new Error(`GitHub repo file not found: ${normalized}`);
  }
  if (!response.ok) {
    throw new Error(
      `GitHub file fetch failed (${response.status}): ${(await response.text()).slice(0, 200)}`,
    );
  }
  const payload = (await response.json()) as { content?: string; encoding?: string };
  if (!payload.content || payload.encoding !== "base64") {
    throw new Error(`GitHub returned non-file content for ${normalized}`);
  }
  return Buffer.from(payload.content, "base64").toString("utf8");
}

async function readLocalGitFile(relativePath: string): Promise<string | null> {
  const paprDir = getPaprRoot();
  if (!fs.existsSync(path.join(paprDir, ".git"))) {
    return null;
  }
  const runner = new GitRunner();
  try {
    return await runner.run(["show", `HEAD:${relativePath.trim().replace(/^\/+/, "")}`], {
      cwd: paprDir,
      timeout: 20_000,
    });
  } catch {
    return null;
  }
}

export function assertReadOnlySql(sql: string): void {
  const trimmed = sql.trim();
  if (!trimmed) {
    throw new Error("SQL query is required.");
  }
  const normalized = trimmed.replace(/\s+/g, " ").toUpperCase();
  const forbidden =
    /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|GRANT|REVOKE|TRUNCATE|VACUUM|REINDEX)\b/;
  if (forbidden.test(normalized)) {
    throw new Error("Only read-only SQL is allowed (SELECT/WITH/PRAGMA/EXPLAIN).");
  }
  if (!/^(SELECT|WITH|PRAGMA|EXPLAIN)\b/.test(normalized)) {
    throw new Error("Only SELECT, WITH, PRAGMA, or EXPLAIN statements are allowed.");
  }
}

export async function resolveTursoDatabaseName(input: {
  tursoDatabase?: string;
  jobId?: string;
  appId?: string;
  alias?: string;
}): Promise<string> {
  if (input.tursoDatabase?.trim()) {
    return input.tursoDatabase.trim();
  }
  if (input.jobId?.trim()) {
    return jobTursoDatabaseName(input.jobId.trim());
  }
  if (input.appId?.trim() && input.alias?.trim()) {
    const sources = await discoverTursoLinkedSources(getPaprAppsRoot());
    const match = sources.find(
      (source) =>
        source.appId === input.appId?.trim() &&
        source.alias === input.alias?.trim(),
    );
    if (!match) {
      throw new Error(
        `No linked database alias "${input.alias}" for app ${input.appId}. Check data-sources.json.`,
      );
    }
    return resolveTursoDatabaseLabel(match);
  }
  throw new Error(
    "Provide tursoDatabase, jobId, or appId+alias to select a Turso database.",
  );
}

export async function getCloudSyncStatus(options?: {
  appId?: string;
  jobId?: string;
  includeJobLogs?: boolean;
  logTailLines?: number;
}): Promise<CloudSyncStatusReport> {
  const sync = getCloudSyncService();
  const checkedAt = new Date().toISOString();
  const emptyJobs = { local: [], githubRecords: [] };

  if (!sync) {
    return {
      enabled: false,
      reason: "Cloud sync not initialized",
      syncState: null,
      github: null,
      turso: null,
      cloudLinks: null,
      desktopHeartbeat: null,
      jobs: emptyJobs,
      checkedAt,
    };
  }

  const appId = options?.appId?.trim();
  const jobId = options?.jobId?.trim();
  const paprDir = getPaprRoot();
  if (appId) {
    await sync.reconcileAppDependentPaths(appId);
  }

  let github = sync.getGitHubSyncItemsReport();
  if (appId) {
    github = filterGitHubReportByApp(github, appId, paprDir);
  }

  const turso = await buildTursoSyncItemsReport(getPaprAppsRoot(), appId);
  let cloudLinks: Awaited<ReturnType<typeof buildCloudLinkSyncReport>> | null =
    null;
  if (!appId) {
    cloudLinks = await buildCloudLinkSyncReport();
  } else {
    const allLinks = await buildCloudLinkSyncReport();
    cloudLinks = {
      ...allLinks,
      items: allLinks.items.filter((item) => item.appId === appId),
      summary: {
        live: allLinks.items.filter((i) => i.appId === appId && i.status === "live")
          .length,
        pending: allLinks.items.filter(
          (i) => i.appId === appId && i.status === "pending",
        ).length,
        disabled: allLinks.items.filter(
          (i) => i.appId === appId && i.status === "disabled",
        ).length,
        unavailable: allLinks.items.filter(
          (i) => i.appId === appId && i.status === "unavailable",
        ).length,
        total: allLinks.items.filter((i) => i.appId === appId).length,
      },
    };
  }

  let desktopHeartbeat: CloudSyncStatusReport["desktopHeartbeat"] = null;
  try {
    const apiKey = await getPaprApiKey();
    if (apiKey) {
      const heartbeat = await getCloudRuntimeClient().sendDesktopHeartbeat(apiKey);
      desktopHeartbeat = {
        desktopAwake: heartbeat.desktopAwake,
        recordedAt: heartbeat.recordedAt,
        staleAfterSeconds: heartbeat.staleAfterSeconds,
        pendingCloudRuns: heartbeat.pendingCloudRuns ?? [],
      };
    }
  } catch (err) {
    desktopHeartbeat = {
      desktopAwake: false,
      recordedAt: checkedAt,
      staleAfterSeconds: 0,
      pendingCloudRuns: [],
    };
    if (process.env.NODE_ENV !== "test") {
      console.warn(
        "[CloudObservability] Heartbeat check failed:",
        (err as Error).message.slice(0, 120),
      );
    }
  }

  const jobs = await buildJobsSection({
    appId,
    jobId,
    includeLogs: options?.includeJobLogs,
    logTailLines: options?.logTailLines,
  });

  return {
    enabled: true,
    syncState: sync.getState(),
    github,
    turso,
    cloudLinks,
    desktopHeartbeat,
    jobs,
    ...(appId
      ? {
          appContext: {
            appId,
            dependentJobIds: resolveAppDependentJobIds(paprDir, appId),
            registryDbIds: readDataSourceRegistryDbIds(paprDir, appId),
          },
        }
      : {}),
    checkedAt,
  };
}

export type PushCloudSyncTarget = "github" | "turso";

export interface PushCloudSyncOptions {
  appId?: string;
  jobId?: string;
  alias?: string;
  tursoDatabase?: string;
  tables?: string[];
  /** What to upload. Default: both. Use ["turso"] for fast DB-only pushes. */
  targets?: PushCloudSyncTarget[];
}

export interface PushCloudSyncResult {
  success: true;
  scope: string;
  targets: PushCloudSyncTarget[];
  appId?: string;
  jobId?: string;
  alias?: string;
  tursoDatabase?: string;
  tables?: string[];
  github?: PushGitScopedResult;
  turso?: TursoPushScopedResult;
  flush?: import("./cloudSync/flushAppNow.js").FlushAppNowResult;
  syncState: ReturnType<NonNullable<ReturnType<typeof getCloudSyncService>>["getState"]>;
  pushedAt: string;
  durationMs: number;
}

function buildPushCloudSyncScopeLabel(options: PushCloudSyncOptions): string {
  const parts: string[] = [];
  if (options.appId) {
    parts.push(`app ${options.appId.slice(0, 8)}…`);
  }
  if (options.jobId) {
    parts.push(`job ${options.jobId.slice(0, 8)}…`);
  }
  if (options.alias) {
    parts.push(`db alias "${options.alias}"`);
  }
  if (options.tursoDatabase) {
    parts.push(`Turso ${options.tursoDatabase}`);
  }
  if (options.tables?.length) {
    parts.push(`tables ${options.tables.join(", ")}`);
  }
  return parts.length > 0 ? parts.join(", ") : "full workspace";
}

function resolvePushCloudSyncTargets(
  options: PushCloudSyncOptions,
): PushCloudSyncTarget[] {
  if (options.targets?.length) {
    return [...options.targets];
  }
  return ["github", "turso"];
}

export async function pushCloudSync(
  options?: PushCloudSyncOptions,
): Promise<PushCloudSyncResult> {
  const startMs = performance.now();
  const sync = getCloudSyncService();
  if (!sync) {
    throw new Error("Cloud sync not initialized. Enable Cloud Sync in Settings.");
  }

  const pushOptions: PushCloudSyncOptions = options ?? {};
  const targets = resolvePushCloudSyncTargets(pushOptions);
  const scope = buildPushCloudSyncScopeLabel(pushOptions);

  if (
    pushOptions.appId &&
    targets.includes("github") &&
    targets.includes("turso")
  ) {
    const { getSyncCoordinator } = await import("./cloudSync/SyncCoordinator.js");
    const coordinator = getSyncCoordinator();
    const flush = coordinator
      ? await coordinator.flushNow(pushOptions.appId, { trigger: "manual" })
      : await (async () => {
          const { flushAppNow } = await import("./cloudSync/flushAppNow.js");
          return flushAppNow(sync, pushOptions.appId!, {
            skipTursoReschedule: true,
          });
        })();
    return {
      success: true,
      scope,
      targets,
      appId: pushOptions.appId,
      flush,
      syncState: sync.getState(),
      pushedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - startMs),
    };
  }

  let github: PushGitScopedResult | undefined;
  if (targets.includes("github")) {
    github = await sync.pushGitNow({
      appId: pushOptions.appId,
      jobId: pushOptions.jobId,
    });
  }

  let turso: TursoPushScopedResult | undefined;
  if (targets.includes("turso")) {
    const bridge = getTursoSyncBridge();
    if (!bridge) {
      throw new Error("Turso sync is not initialized.");
    }
    const hasTursoScope =
      Boolean(pushOptions.appId) ||
      Boolean(pushOptions.jobId) ||
      Boolean(pushOptions.alias) ||
      Boolean(pushOptions.tursoDatabase) ||
      Boolean(pushOptions.tables?.length);

    turso = await bridge.pushScoped({
      appId: pushOptions.appId,
      jobId: pushOptions.jobId,
      alias: pushOptions.alias,
      tursoDatabase: pushOptions.tursoDatabase,
      tables: pushOptions.tables,
      dirtyOnly: !hasTursoScope,
    });

    if (turso.failed > 0) {
      const errors = turso.results
        .filter((result) => result.error)
        .map((result) => result.error)
        .join("; ");
      throw new Error(
        errors.length > 0
          ? `Database sync to Turso failed: ${errors}`
          : "Database sync to Turso failed",
      );
    }
  }

  return {
    success: true,
    scope,
    targets,
    ...(pushOptions.appId ? { appId: pushOptions.appId } : {}),
    ...(pushOptions.jobId ? { jobId: pushOptions.jobId } : {}),
    ...(pushOptions.alias ? { alias: pushOptions.alias } : {}),
    ...(pushOptions.tursoDatabase ? { tursoDatabase: pushOptions.tursoDatabase } : {}),
    ...(pushOptions.tables?.length ? { tables: pushOptions.tables } : {}),
    ...(github ? { github } : {}),
    ...(turso ? { turso } : {}),
    syncState: sync.getState(),
    pushedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - startMs),
  };
}

export async function queryCloudTurso(input: {
  sql: string;
  tursoDatabase?: string;
  jobId?: string;
  appId?: string;
  alias?: string;
  maxRows?: number;
}): Promise<CloudTursoQueryResult> {
  await requirePaprApiKey();
  assertReadOnlySql(input.sql);

  const bridge = getTursoSyncBridge();
  if (!bridge) {
    throw new Error("Turso sync is not initialized.");
  }

  const tursoDatabase = await resolveTursoDatabaseName(input);
  const maxRows = Math.min(
    Math.max(1, input.maxRows ?? DEFAULT_MAX_ROWS),
    MAX_ROWS_CAP,
  );

  let sql = input.sql.trim();
  if (/^SELECT\b/i.test(sql) && !/\bLIMIT\b/i.test(sql)) {
    sql = `${sql.replace(/;\s*$/, "")} LIMIT ${maxRows + 1}`;
  }

  const credentials = await bridge.fetchCredentials(tursoDatabase);
  const client = createClient({
    url: credentials.tursoUrl,
    authToken: credentials.authToken,
  });

  try {
    const result = await client.execute(sql);
    const columns = result.columns.map(String);
    const rows = result.rows.slice(0, maxRows).map((row) => {
      const record: Record<string, unknown> = {};
      for (const column of columns) {
        record[column] = row[column as keyof typeof row];
      }
      return record;
    });
    return {
      tursoDatabase,
      columns,
      rows,
      rowCount: rows.length,
      truncated: result.rows.length > maxRows,
    };
  } finally {
    client.close();
  }
}

export async function readCloudRepoFile(input: {
  relativePath: string;
  source?: "github" | "local-git";
  maxChars?: number;
}): Promise<{
  relativePath: string;
  content: string;
  truncated: boolean;
  source: "github" | "local-git";
}> {
  const relativePath = input.relativePath.trim().replace(/^\/+/, "");
  const preferGitHub = input.source !== "local-git";
  let content: string | null = null;
  let source: "github" | "local-git" = "github";

  if (preferGitHub) {
    content = await readGitHubRepoFile(relativePath);
  } else {
    content = await readLocalGitFile(relativePath);
    source = "local-git";
    if (!content) {
      throw new Error(
        `Local git HEAD does not contain ${relativePath}. Try source=github or push/sync first.`,
      );
    }
  }

  const maxChars = input.maxChars ?? DEFAULT_REPO_FILE_CHARS;
  const truncated = content.length > maxChars;
  return {
    relativePath,
    content: truncated ? content.slice(0, maxChars) : content,
    truncated,
    source,
  };
}

export async function listCloudRepoFiles(input?: {
  prefix?: string;
  maxFiles?: number;
}): Promise<{ prefix: string; files: string[]; source: "local-git-head" }> {
  const paprDir = getPaprRoot();
  const gitDir = path.join(paprDir, ".git");
  if (!fs.existsSync(gitDir)) {
    throw new Error(
      "Local cloud git repo not initialized. Enable Cloud Sync and push once before listing repo files.",
    );
  }

  const prefix = (input?.prefix ?? "apps/").trim().replace(/^\/+/, "");
  const maxFiles = Math.min(Math.max(1, input?.maxFiles ?? 200), 500);
  const runner = new GitRunner();
  const output = await runner.run(
    ["ls-tree", "-r", "--name-only", "HEAD", "--", prefix],
    { cwd: paprDir, timeout: 30_000 },
  );
  const files = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxFiles);

  return { prefix, files, source: "local-git-head" };
}

async function readJobLogTail(jobId: string, lines: number): Promise<string | undefined> {
  const logPath = path.join(getPaprRoot(), "Jobs", jobId, "logs", "run.log");
  try {
    const raw = await fs.promises.readFile(logPath, "utf8");
    const tail = raw.split("\n").slice(-lines).join("\n").trim();
    return tail || undefined;
  } catch {
    return undefined;
  }
}

async function buildJobsSection(input: {
  appId?: string;
  jobId?: string;
  includeLogs?: boolean;
  logTailLines?: number;
}): Promise<CloudSyncStatusReport["jobs"]> {
  const jobsService = getJobsService();
  await jobsService.initialize();

  const appId = input.appId?.trim();
  const jobId = input.jobId?.trim();
  let jobs = await jobsService.listJobs(appId ? { appId } : undefined);
  if (jobId) {
    jobs = jobs.filter((job) => job.id === jobId);
  }

  const includeLogs = input.includeLogs ?? Boolean(jobId);
  const logTailLines = input.logTailLines ?? DEFAULT_LOG_TAIL_LINES;

  const local = await Promise.all(
    jobs.slice(0, 50).map(async (job) => ({
      id: job.id,
      name: job.name,
      type: job.type,
      status: job.status,
      lastRunAt: job.lastRunAt,
      completedAt: job.completedAt,
      error: job.error ?? null,
      ...(includeLogs
        ? { logTail: await readJobLogTail(job.id, logTailLines) }
        : {}),
    })),
  );

  let githubRecords: CloudSyncStatusReport["jobs"]["githubRecords"] = [];
  if (appId) {
    const dependentJobIds = resolveAppDependentJobIds(getPaprRoot(), appId);
    githubRecords = await Promise.all(
      dependentJobIds.slice(0, 20).map(async (dependentJobId) => {
        const relativePath = `Jobs/${dependentJobId}/job.json`;
        try {
          const raw = await readGitHubRepoFile(relativePath);
          const record = JSON.parse(raw) as Record<string, unknown>;
          return { jobId: dependentJobId, relativePath, found: true, record };
        } catch {
          return { jobId: dependentJobId, relativePath, found: false };
        }
      }),
    );
  }

  return { local, githubRecords };
}

/** @deprecated Use getCloudSyncStatus — jobs are included there. */
export async function getCloudJobsStatus(input?: {
  appId?: string;
  jobId?: string;
  includeLogs?: boolean;
  logTailLines?: number;
}): Promise<CloudSyncStatusReport["jobs"] & { pendingCloudRuns: PendingCloudRunNotification[]; desktopAwake: boolean | null; checkedAt: string }> {
  const jobs = await buildJobsSection({
    appId: input?.appId,
    jobId: input?.jobId,
    includeLogs: input?.includeLogs,
    logTailLines: input?.logTailLines,
  });
  let pendingCloudRuns: PendingCloudRunNotification[] = [];
  let desktopAwake: boolean | null = null;
  try {
    const apiKey = await getPaprApiKey();
    if (apiKey) {
      const heartbeat = await getCloudRuntimeClient().sendDesktopHeartbeat(apiKey);
      desktopAwake = heartbeat.desktopAwake;
      pendingCloudRuns = heartbeat.pendingCloudRuns ?? [];
    }
  } catch {
    desktopAwake = null;
  }
  if (input?.jobId?.trim()) {
    pendingCloudRuns = pendingCloudRuns.filter(
      (run) => run.jobId === input.jobId?.trim(),
    );
  }
  return {
    ...jobs,
    pendingCloudRuns,
    desktopAwake,
    checkedAt: new Date().toISOString(),
  };
}
