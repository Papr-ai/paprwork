/**
 * Auto-reconcile diverged git when cloud only wrote runtime metadata (job status).
 *
 * Cloud agent runs commit Jobs/{id}/job.json and data/jobs.json while the desktop
 * sleeps. That must not block app code upload or require manual merge — only
 * remote changes to app/job source code need owner review (SYNC_CONTRACT §6).
 */

import { isLocalOnlyCloudSyncArtifact } from "./gitSyncLimits.js";

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

/** App or job source files on remote — require owner review when changed. */
export function isRemoteAppOrJobSourceGitPath(relativePath: string): boolean {
  const normalized = normalizeGitPath(relativePath);
  if (isCloudRuntimeMetadataGitPath(normalized)) {
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

export function parsePorcelainChangedPaths(porcelain: string): string[] {
  return porcelain
    .trimEnd()
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 3)
    .map((line) => normalizeGitPath(line.slice(3)));
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
      isEphemeralLocalSyncStatePath(relativePath)
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
    if (isCloudJobStatusWritebackLine(line)) {
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
  const dirtyPaths = parsePorcelainChangedPaths(porcelain);

  const { restoreBeforeMerge, stashBeforeMerge } =
    categorizeWorkingTreePathsForRemoteMerge(dirtyPaths);

  let restoredMetadataPaths = 0;
  let restoredEphemeralPaths = 0;
  for (const relativePath of restoreBeforeMerge) {
    if (isCloudRuntimeMetadataGitPath(relativePath)) {
      restoredMetadataPaths += 1;
    } else {
      restoredEphemeralPaths += 1;
    }
  }

  if (restoreBeforeMerge.length > 0) {
    await restoreWorktreePaths(runGit, restoreBeforeMerge);
  }

  const stashedSourcePaths = stashBeforeMerge.length;
  let didStash = false;
  if (stashBeforeMerge.length > 0) {
    // Path-scoped stash — stashing 200+ job.json files overwhelms the git index.
    await runGitWithIndexRetry(runGit, [
      "stash",
      "push",
      "-m",
      stashMessage,
      "--",
      ...stashBeforeMerge.map(toLiteralPathspec),
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
