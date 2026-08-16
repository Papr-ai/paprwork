/**
 * Auto-reconcile diverged git when cloud only wrote runtime metadata (job status).
 *
 * Cloud agent runs commit Jobs/{id}/job.json and data/jobs.json while the desktop
 * sleeps. That must not block app code upload or require manual merge — only
 * remote changes to app/job source code need owner review (SYNC_CONTRACT §6).
 *
 * When JOB_RUNTIME_OFF_GIT=1, job runtime is delivered via heartbeat patches —
 * legacy job.json / jobs.json status writebacks are ignored (not auto-merged).
 */

import { WORKSPACE_CHAT_JOB_ID } from "../../../core/constants/workspaceChatJob.js";
import { isJobRuntimeOffGit } from "../jobs/jobRuntimeOffGit.js";
import { isLocalOnlyCloudSyncArtifact } from "./gitSyncLimits.js";

const WORKSPACE_CHAT_JOBS_PREFIX = `Jobs/${WORKSPACE_CHAT_JOB_ID}/`;

/** Papr Web hidden agent job — cloud-managed infrastructure, never owner-reviewed. */
export function isWorkspaceChatInfrastructureGitPath(relativePath: string): boolean {
  const normalized = normalizeGitPath(relativePath);
  return (
    normalized === `Jobs/${WORKSPACE_CHAT_JOB_ID}/job.json` ||
    normalized.startsWith(WORKSPACE_CHAT_JOBS_PREFIX)
  );
}

/** Remote diff is only workspace-chat scaffold + jobs index — safe to auto-merge silently. */
export function areWorkspaceChatInfrastructureOnlyChanges(
  relativePaths: readonly string[],
): boolean {
  if (relativePaths.length === 0) {
    return false;
  }
  return relativePaths.every((relativePath) => {
    const normalized = normalizeGitPath(relativePath);
    return (
      isWorkspaceChatInfrastructureGitPath(normalized) ||
      normalized === "data/jobs.json"
    );
  });
}

export type GitRemoteReconcileResult =
  | "not_needed"
  | "merged"
  | "requires_review"
  | "merge_failed";

export type IncomingRemoteChangeClass =
  | "not_needed"
  | "runtime_metadata_only"
  | "requires_review";

export type RunGitFn = (
  args: string[],
  opts?: { timeout?: number },
) => Promise<string>;

export function normalizeGitPath(relativePath: string): string {
  return relativePath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

/** Paths cloud runtime writebacks touch — safe to auto-merge without owner review. */
export function isCloudRuntimeMetadataGitPath(relativePath: string): boolean {
  const normalized = normalizeGitPath(relativePath);
  if (isWorkspaceChatInfrastructureGitPath(normalized)) {
    return true;
  }
  if (isJobRuntimeOffGit()) {
    // Runtime off git: only repo markers auto-merge; job definitions are config, not status metadata.
    if (normalized === "data/cloud-repo-head.txt") {
      return true;
    }
    if (/^apps\/[^/]+\/\.papr-cloud-revision$/.test(normalized)) {
      return true;
    }
    return false;
  }
  if (normalized === "data/jobs.json") {
    return true;
  }
  if (normalized === "data/cloud-repo-head.txt") {
    return true;
  }
  if (/^apps\/[^/]+\/\.papr-cloud-revision$/.test(normalized)) {
    return true;
  }
  return /^Jobs\/[^/]+\/job\.json$/.test(normalized);
}

/** Legacy cloud status writeback paths (ignored when JOB_RUNTIME_OFF_GIT=1). */
export function isLegacyJobRuntimeGitPath(relativePath: string): boolean {
  const normalized = normalizeGitPath(relativePath);
  return (
    normalized === "data/jobs.json" ||
    /^Jobs\/[^/]+\/job\.json$/.test(normalized)
  );
}

export function areLegacyJobRuntimeGitPathsOnly(
  relativePaths: readonly string[],
): boolean {
  if (relativePaths.length === 0) {
    return false;
  }
  return relativePaths.every(isLegacyJobRuntimeGitPath);
}

/** App or job source files on remote — require owner review when changed. */
export function isRemoteAppOrJobSourceGitPath(relativePath: string): boolean {
  const normalized = normalizeGitPath(relativePath);
  if (isCloudRuntimeMetadataGitPath(normalized)) {
    return false;
  }
  if (isJobRuntimeOffGit() && isLegacyJobRuntimeGitPath(normalized)) {
    return false;
  }
  if (/^apps\/[^/]+\/.+/.test(normalized)) {
    return true;
  }
  if (/^Jobs\/[^/]+\/.+/.test(normalized)) {
    return true;
  }
  return false;
}

export function hasRemoteAppOrJobSourceChanges(
  relativePaths: readonly string[],
): boolean {
  return relativePaths.some(isRemoteAppOrJobSourceGitPath);
}

export function areCloudRuntimeMetadataOnlyChanges(
  relativePaths: readonly string[],
): boolean {
  if (relativePaths.length === 0) {
    return false;
  }
  return relativePaths.every(isCloudRuntimeMetadataGitPath);
}

export function parseGitNameOnlyOutput(output: string): string[] {
  return output
    .split("\n")
    .map((line) => normalizeGitPath(line.trim()))
    .filter(Boolean);
}

/**
 * Files changed on origin/main since the merge-base with HEAD (remote-only).
 * Uses three-dot diff — two-dot HEAD..origin/main wrongly includes local-only
 * changes when branches diverged (blocks metadata auto-merge during app upload).
 */
export async function listIncomingRemoteChangedPaths(
  runGit: RunGitFn,
): Promise<string[]> {
  const raw = await runGit(["diff", "--name-only", "HEAD...origin/main"]);
  return parseGitNameOnlyOutput(raw);
}

export async function classifyIncomingRemoteChanges(
  runGit: RunGitFn,
): Promise<IncomingRemoteChangeClass> {
  await runGit(["fetch", "origin", "main"]);
  const behindRaw = await runGit(["rev-list", "--count", "HEAD..origin/main"]);
  const behindCount = parseInt(behindRaw.trim(), 10) || 0;
  if (behindCount === 0) {
    return "not_needed";
  }
  const summary = (
    await runGit(["log", "--oneline", "-30", "HEAD..origin/main"])
  ).trim();
  const paths = await listIncomingRemoteChangedPaths(runGit);
  if (
    paths.length > 0 &&
    areWorkspaceChatInfrastructureOnlyChanges(paths)
  ) {
    return "runtime_metadata_only";
  }
  if (isJobRuntimeOffGit()) {
    if (
      paths.length > 0 &&
      areLegacyJobRuntimeGitPathsOnly(paths) &&
      !hasRemoteAppOrJobSourceChanges(paths)
    ) {
      return "not_needed";
    }
    if (
      paths.length === 0 &&
      summary &&
      isCloudJobStatusWritebackSummary(summary)
    ) {
      return "not_needed";
    }
    if (
      paths.length === 0 &&
      summary &&
      isCloudWorkspaceChatInfrastructureSummary(summary)
    ) {
      return "runtime_metadata_only";
    }
  }
  if (paths.length > 0) {
    if (areCloudRuntimeMetadataOnlyChanges(paths)) {
      return "runtime_metadata_only";
    }
    if (
      summary &&
      isCloudJobStatusWritebackSummary(summary) &&
      !hasRemoteAppOrJobSourceChanges(paths)
    ) {
      return "runtime_metadata_only";
    }
    return "requires_review";
  }
  if (summary && isCloudJobStatusWritebackSummary(summary)) {
    return "runtime_metadata_only";
  }
  return "requires_review";
}

export interface PorcelainChangedEntry {
  path: string;
  untracked: boolean;
}

export function parsePorcelainEntries(porcelain: string): PorcelainChangedEntry[] {
  return porcelain
    .trimEnd()
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 3)
    .map((line) => {
      const path = normalizeGitPath(line.slice(3));
      const indexStatus = line[0] ?? " ";
      const worktreeStatus = line[1] ?? " ";
      return {
        path,
        untracked: indexStatus === "?" && worktreeStatus === "?",
      };
    });
}

export function parsePorcelainChangedPaths(porcelain: string): string[] {
  return parsePorcelainEntries(porcelain).map((entry) => entry.path);
}

/** git restore only works on tracked paths; untracked ephemerals need git clean. */
export function splitRestorePathsForRemoteMerge(
  restoreBeforeMerge: readonly string[],
  entries: readonly PorcelainChangedEntry[],
): { trackedRestorePaths: string[]; untrackedCleanPaths: string[] } {
  const untrackedPaths = new Set(
    entries.filter((entry) => entry.untracked).map((entry) => entry.path),
  );
  const trackedRestorePaths: string[] = [];
  const untrackedCleanPaths: string[] = [];
  for (const relativePath of restoreBeforeMerge) {
    if (untrackedPaths.has(relativePath)) {
      untrackedCleanPaths.push(relativePath);
    } else {
      trackedRestorePaths.push(relativePath);
    }
  }
  return { trackedRestorePaths, untrackedCleanPaths };
}

/** Local-only sync state — discard before merge; remote merge is authoritative for metadata. */
export function isEphemeralLocalSyncStatePath(relativePath: string): boolean {
  const normalized = normalizeGitPath(relativePath);
  const baseName = normalized.split("/").pop() ?? normalized;
  if (isLocalOnlyCloudSyncArtifact(baseName)) {
    return true;
  }
  if (normalized.startsWith(".npm/")) {
    return true;
  }
  if (normalized.startsWith("backups/")) {
    return true;
  }
  if (normalized === "data/.db-memory-sync-state.json") {
    return true;
  }
  if (normalized === "data/.turso-convergence-state.json") {
    return true;
  }
  return false;
}

export function categorizeWorkingTreePathsForRemoteMerge(paths: readonly string[]): {
  restoreBeforeMerge: string[];
  stashBeforeMerge: string[];
} {
  const restoreBeforeMerge: string[] = [];
  const stashBeforeMerge: string[] = [];
  for (const relativePath of paths) {
    if (
      isCloudRuntimeMetadataGitPath(relativePath) ||
      isEphemeralLocalSyncStatePath(relativePath) ||
      // When JOB_RUNTIME_OFF_GIT=1, legacy job status paths (Jobs/*/job.json, data/jobs.json)
      // contain only runtime data locally — discard local changes, take remote.
      (isJobRuntimeOffGit() && isLegacyJobRuntimeGitPath(relativePath))
    ) {
      restoreBeforeMerge.push(relativePath);
    } else {
      stashBeforeMerge.push(relativePath);
    }
  }
  return { restoreBeforeMerge, stashBeforeMerge };
}

function chunkPaths(paths: readonly string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < paths.length; i += size) {
    chunks.push(paths.slice(i, i + size));
  }
  return chunks;
}

function toLiteralPathspec(relativePath: string): string {
  return `:(literal)${normalizeGitPath(relativePath)}`;
}

async function restoreWorktreePaths(
  runGit: RunGitFn,
  paths: readonly string[],
): Promise<void> {
  if (paths.length === 0) {
    return;
  }
  for (const chunk of chunkPaths(paths, 40)) {
    await runGitWithIndexRetry(runGit, [
      "restore",
      "--worktree",
      "--",
      ...chunk.map(toLiteralPathspec),
    ]);
  }
}

async function cleanUntrackedPaths(
  runGit: RunGitFn,
  paths: readonly string[],
): Promise<void> {
  if (paths.length === 0) {
    return;
  }
  for (const chunk of chunkPaths(paths, 40)) {
    await runGitWithIndexRetry(runGit, [
      "clean",
      "-fd",
      "--",
      ...chunk.map(toLiteralPathspec),
    ]);
  }
}

export interface MergeRemoteMainResult {
  restoredMetadataPaths: number;
  restoredEphemeralPaths: number;
  stashedSourcePaths: number;
}

/** Stash dirty tree if needed, merge origin/main, restore stash. Caller holds git lock. */
export function parseIncomingRemoteGitLogLines(summary: string): string[] {
  return summary
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Single commit line: cloud runtime wrote job status metadata. */
export function isCloudJobStatusWritebackLine(line: string): boolean {
  return /^[0-9a-f]{7,40}\s+cloud:\s+update job .+ status$/i.test(line.trim());
}

/** Single commit line: Papr Web workspace-chat infrastructure scaffold (auto-merge). */
export function isCloudWorkspaceChatInfrastructureLine(line: string): boolean {
  return /^[0-9a-f]{7,40}\s+cloud:\s+(add workspace-chat|scaffold workspace-chat)/i.test(
    line.trim(),
  );
}

export function isCloudInfrastructureAutoMergeLine(line: string): boolean {
  return (
    isCloudJobStatusWritebackLine(line) ||
    isCloudWorkspaceChatInfrastructureLine(line)
  );
}

/** Single commit line: owner merged contributed app code on GitHub. */
export function isContribMergeCommitLine(line: string): boolean {
  return /^[0-9a-f]{7,40}\s+contrib:/i.test(line.trim());
}

/** True when git log lines are cloud job status writebacks (metadata, not app code). */
export function isCloudJobStatusWritebackSummary(summary: string): boolean {
  const lines = parseIncomingRemoteGitLogLines(summary);
  if (lines.length === 0) {
    return false;
  }
  return lines.every((line) => isCloudJobStatusWritebackLine(line));
}

/** True when git log is Papr Web workspace-chat scaffold only (auto-merge). */
export function isCloudWorkspaceChatInfrastructureSummary(summary: string): boolean {
  const lines = parseIncomingRemoteGitLogLines(summary);
  if (lines.length === 0) {
    return false;
  }
  return lines.every((line) => isCloudWorkspaceChatInfrastructureLine(line));
}

export interface IncomingRemoteGitLogSummary {
  totalCommits: number;
  jobStatusCount: number;
  contribCount: number;
  otherCount: number;
  hasAppSourcePaths: boolean;
  headline: string;
}

/** Human-readable breakdown for UI/logs when remote is ahead. */
export function summarizeIncomingRemoteGitLog(
  summary: string | null | undefined,
  remotePaths?: readonly string[],
): IncomingRemoteGitLogSummary {
  const lines = parseIncomingRemoteGitLogLines(summary ?? "");
  let jobStatusCount = 0;
  let contribCount = 0;
  let otherCount = 0;
  for (const line of lines) {
    if (isCloudInfrastructureAutoMergeLine(line)) {
      jobStatusCount += 1;
    } else if (isContribMergeCommitLine(line)) {
      contribCount += 1;
    } else {
      otherCount += 1;
    }
  }
  const hasAppSourcePaths = remotePaths
    ? hasRemoteAppOrJobSourceChanges(remotePaths)
    : false;

  const parts: string[] = [];
  if (contribCount > 0) {
    parts.push(
      contribCount === 1
        ? "1 contributed code merge"
        : `${contribCount} contributed code merges`,
    );
  }
  if (jobStatusCount > 0) {
    parts.push(
      jobStatusCount === 1
        ? "1 cloud job status update"
        : `${jobStatusCount} cloud job status updates`,
    );
  }
  if (otherCount > 0) {
    parts.push(
      otherCount === 1
        ? "1 other remote commit"
        : `${otherCount} other remote commits`,
    );
  }

  return {
    totalCommits: lines.length,
    jobStatusCount,
    contribCount,
    otherCount,
    hasAppSourcePaths,
    headline: parts.length > 0 ? parts.join(" + ") : "Remote commits on cloud",
  };
}

export function formatIncomingRemoteReviewBlockReason(
  summary: string | null | undefined,
  remotePaths: readonly string[],
): string {
  const breakdown = summarizeIncomingRemoteGitLog(summary, remotePaths);
  const sourcePaths = remotePaths.filter(isRemoteAppOrJobSourceGitPath);
  if (sourcePaths.length === 0) {
    return breakdown.headline;
  }
  const preview = sourcePaths.slice(0, 2).join(", ");
  const suffix =
    sourcePaths.length > 2 ? ` (+${sourcePaths.length - 2} more)` : "";
  return `${breakdown.headline} — includes app code (${preview}${suffix})`;
}

export function inferGitRemoteReviewState(opts: {
  gitUpdatesAvailable: boolean;
  remoteChangedPaths: readonly string[] | null | undefined;
  gitUpdatesSummary: string | null | undefined;
}): { requiresReview: boolean; metadataSync: boolean } {
  if (!opts.gitUpdatesAvailable) {
    return { requiresReview: false, metadataSync: false };
  }
  const paths = opts.remoteChangedPaths ?? [];
  const summary = opts.gitUpdatesSummary;
  if (isJobRuntimeOffGit()) {
    if (paths.length > 0) {
      if (areWorkspaceChatInfrastructureOnlyChanges(paths)) {
        return { requiresReview: false, metadataSync: true };
      }
      if (
        areLegacyJobRuntimeGitPathsOnly(paths) &&
        !hasRemoteAppOrJobSourceChanges(paths)
      ) {
        return { requiresReview: false, metadataSync: false };
      }
      if (hasRemoteAppOrJobSourceChanges(paths)) {
        return { requiresReview: true, metadataSync: false };
      }
      if (areCloudRuntimeMetadataOnlyChanges(paths)) {
        return { requiresReview: false, metadataSync: true };
      }
      // Even metadata-only paths need review if gitUpdatesAvailable is true —
      // auto-merge already failed or wasn't possible, user must resolve manually.
      // Returning false here would leave UI showing "Get updates" when push is blocked.
      return { requiresReview: true, metadataSync: false };
    }
    if (
      summary &&
      (isCloudJobStatusWritebackSummary(summary) ||
        isCloudWorkspaceChatInfrastructureSummary(summary))
    ) {
      return { requiresReview: false, metadataSync: false };
    }
    return { requiresReview: true, metadataSync: false };
  }
  if (
    summary &&
    isCloudJobStatusWritebackSummary(summary) &&
    !hasRemoteAppOrJobSourceChanges(paths)
  ) {
    return { requiresReview: false, metadataSync: true };
  }
  if (paths.length > 0) {
    const metadataOnly = areCloudRuntimeMetadataOnlyChanges(paths);
    return { requiresReview: !metadataOnly, metadataSync: metadataOnly };
  }
  if (summary && isCloudJobStatusWritebackSummary(summary)) {
    return { requiresReview: false, metadataSync: true };
  }
  return { requiresReview: true, metadataSync: false };
}

export function isNonRetryableCloudPushError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("review updates before pushing") ||
    lower.includes("updates_available")
  );
}

function isGitIndexLockError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("could not write index") ||
    lower.includes("index.lock") ||
    lower.includes("unable to write index")
  );
}

/** Retry once after brief pause — index.lock often clears when a prior git op finishes. */
async function runGitWithIndexRetry(
  runGit: RunGitFn,
  args: string[],
): Promise<string> {
  try {
    return await runGit(args);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (!isGitIndexLockError(message)) {
      throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
    return runGit(args);
  }
}

export async function mergeRemoteMainIntoLocal(
  runGit: RunGitFn,
  options?: { stashMessage?: string },
): Promise<MergeRemoteMainResult> {
  const stashMessage = options?.stashMessage ?? "cloud-sync-auto-reconcile";
  const porcelain = await runGit(["status", "--porcelain"]);
  const porcelainEntries = parsePorcelainEntries(porcelain);
  const dirtyPaths = porcelainEntries.map((entry) => entry.path);

  const { restoreBeforeMerge, stashBeforeMerge } =
    categorizeWorkingTreePathsForRemoteMerge(dirtyPaths);

  const { trackedRestorePaths, untrackedCleanPaths } =
    splitRestorePathsForRemoteMerge(restoreBeforeMerge, porcelainEntries);

  let restoredMetadataPaths = 0;
  let restoredEphemeralPaths = 0;
  for (const relativePath of restoreBeforeMerge) {
    if (isCloudRuntimeMetadataGitPath(relativePath)) {
      restoredMetadataPaths += 1;
    } else {
      restoredEphemeralPaths += 1;
    }
  }

  if (untrackedCleanPaths.length > 0) {
    await cleanUntrackedPaths(runGit, untrackedCleanPaths);
  }
  if (trackedRestorePaths.length > 0) {
    await restoreWorktreePaths(runGit, trackedRestorePaths);
  }

  const stashedSourcePaths = stashBeforeMerge.length;
  const untrackedPathSet = new Set(
    porcelainEntries.filter((entry) => entry.untracked).map((entry) => entry.path),
  );
  const trackedStashPaths = stashBeforeMerge.filter(
    (relativePath) => !untrackedPathSet.has(relativePath),
  );
  let didStash = false;
  if (trackedStashPaths.length > 0) {
    const pathspecs = trackedStashPaths.map(toLiteralPathspec);
    console.log(
      `[MergeRemote] Stashing ${trackedStashPaths.length} paths:`,
      trackedStashPaths.slice(0, 5).join(", ") +
        (trackedStashPaths.length > 5 ? ` ... and ${trackedStashPaths.length - 5} more` : ""),
    );
    // Path-scoped stash — stashing 200+ job.json files overwhelms the git index.
    await runGitWithIndexRetry(runGit, [
      "stash",
      "push",
      "-m",
      stashMessage,
      "--",
      ...pathspecs,
    ]);
    didStash = true;
  }

  try {
    await runGitWithIndexRetry(runGit, ["merge", "--ff-only", "origin/main"]);
  } catch {
    await runGitWithIndexRetry(runGit, ["merge", "--no-edit", "origin/main"]);
  }

  if (didStash) {
    try {
      await runGitWithIndexRetry(runGit, ["stash", "pop"]);
    } catch {
      await runGit(["checkout", "--theirs", "."]);
      await runGit(["stash", "drop"]);
    }
  }

  return {
    restoredMetadataPaths,
    restoredEphemeralPaths,
    stashedSourcePaths,
  };
}
