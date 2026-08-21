/**
 * Namespace monorepo git review helpers — ff-only pull + owner review UI.
 *
 * Sync V3: per-app code syncs via app-repo-writer ops, not namespace git.
 * Auto-merge repair (stash/restore/metadata merge) was removed — reconcile is ff-only.
 */

import { WORKSPACE_CHAT_JOB_ID } from "../../../core/constants/workspaceChatJob.js";

const WORKSPACE_CHAT_JOBS_PREFIX = `Jobs/${WORKSPACE_CHAT_JOB_ID}/`;

export type GitRemoteReconcileResult =
  | "not_needed"
  | "merged"
  | "requires_review"
  | "merge_failed";

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

/** Papr Web hidden agent job — cloud-managed infrastructure, never owner-reviewed. */
export function isWorkspaceChatInfrastructureGitPath(relativePath: string): boolean {
  const normalized = normalizeGitPath(relativePath);
  return (
    normalized === `Jobs/${WORKSPACE_CHAT_JOB_ID}/job.json` ||
    normalized.startsWith(WORKSPACE_CHAT_JOBS_PREFIX)
  );
}

/** Remote diff is only workspace-chat scaffold + jobs index — safe to ff-only silently. */
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

/** Paths cloud runtime writebacks touch — ignored for review (runtime off git). */
export function isCloudRuntimeMetadataGitPath(relativePath: string): boolean {
  const normalized = normalizeGitPath(relativePath);
  if (isWorkspaceChatInfrastructureGitPath(normalized)) {
    return true;
  }
  if (normalized === "data/cloud-repo-head.txt") {
    return true;
  }
  return false;
}

/** Legacy cloud status writeback paths (ignored — runtime always off git). */
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

/** Per-app repos (writer ops) — ignore stale apps/* in namespace monorepo review. */
export function isNamespaceAppGitPath(relativePath: string): boolean {
  return /^apps\/[^/]+/.test(normalizeGitPath(relativePath));
}

export function filterNamespaceReconcilePaths(
  relativePaths: readonly string[],
): string[] {
  return relativePaths.filter((relativePath) => !isNamespaceAppGitPath(relativePath));
}

/** App or job source files on remote — require owner review when changed. */
export function isRemoteAppOrJobSourceGitPath(relativePath: string): boolean {
  const normalized = normalizeGitPath(relativePath);
  if (isNamespaceAppGitPath(normalized)) {
    return false;
  }
  if (isCloudRuntimeMetadataGitPath(normalized)) {
    return false;
  }
  if (isLegacyJobRuntimeGitPath(normalized)) {
    return false;
  }
  if (/^Jobs\/[^/]+\/.+/.test(normalized)) {
    return true;
  }
  return false;
}

export function hasRemoteAppOrJobSourceChanges(
  relativePaths: readonly string[],
): boolean {
  return filterNamespaceReconcilePaths(relativePaths).some(
    isRemoteAppOrJobSourceGitPath,
  );
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
 * changes when branches diverged.
 */
export async function listIncomingRemoteChangedPaths(
  runGit: RunGitFn,
): Promise<string[]> {
  const raw = await runGit(["diff", "--name-only", "HEAD...origin/main"]);
  return parseGitNameOnlyOutput(raw);
}

/** True when incoming git log includes a community contribution merge. */
export function hasContribMergeInSummary(summary: string): boolean {
  return parseIncomingRemoteGitLogLines(summary).some(isContribMergeCommitLine);
}

export function parseIncomingRemoteGitLogLines(summary: string): string[] {
  return summary
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function isCloudJobStatusWritebackLine(line: string): boolean {
  return /^[0-9a-f]{7,40}\s+cloud:\s+update job .+ status$/i.test(line.trim());
}

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

export function isContribMergeCommitLine(line: string): boolean {
  return /^[0-9a-f]{7,40}\s+contrib:/i.test(line.trim());
}

export function isCloudJobStatusWritebackSummary(summary: string): boolean {
  const lines = parseIncomingRemoteGitLogLines(summary);
  if (lines.length === 0) {
    return false;
  }
  return lines.every((line) => isCloudJobStatusWritebackLine(line));
}

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

export function isGitHistoryDiverged(
  aheadCount: number,
  behindCount: number,
): boolean {
  return aheadCount > 0 && behindCount > 0;
}

export function formatDivergedGitHistoryHeadline(
  aheadCount: number,
  behindCount: number,
): string {
  const localPart =
    aheadCount === 1 ? "1 local commit" : `${aheadCount} local commits`;
  const remotePart =
    behindCount === 1 ? "1 cloud commit" : `${behindCount} cloud commits`;
  return `Diverged git history (${localPart}, ${remotePart})`;
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
  return `${breakdown.headline} — includes job source (${preview}${suffix})`;
}

export function inferGitRemoteReviewState(opts: {
  gitUpdatesAvailable: boolean;
  remoteChangedPaths: readonly string[] | null | undefined;
  gitUpdatesSummary: string | null | undefined;
  gitHistoryDiverged?: boolean;
}): { requiresReview: boolean; metadataSync: boolean } {
  if (!opts.gitUpdatesAvailable) {
    return { requiresReview: false, metadataSync: false };
  }
  const summary = opts.gitUpdatesSummary ?? "";
  if (summary && hasContribMergeInSummary(summary)) {
    return { requiresReview: true, metadataSync: false };
  }
  if (opts.gitHistoryDiverged === true) {
    return { requiresReview: true, metadataSync: false };
  }
  const rawPaths = opts.remoteChangedPaths ?? [];
  const paths = filterNamespaceReconcilePaths(rawPaths);
  if (rawPaths.length > 0 && paths.length === 0) {
    return { requiresReview: false, metadataSync: false };
  }
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

export function isNonRetryableCloudPushError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("review updates before pushing") ||
    lower.includes("updates_available")
  );
}
