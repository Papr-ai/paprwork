/**
 * Owner-facing display for contribute-back proposals (no private GitHub links).
 */

import type { CloudChangeRequest } from "./cloudChangeRequestsApi";

const MAX_LISTED_PATHS = 12;

export function isResolvedChangeRequest(req: CloudChangeRequest): boolean {
  const status = typeof req.status === "string" ? req.status.trim() : "";
  return status === "approved" || status === "rejected";
}

export function resolvedChangeRequestSortKey(req: CloudChangeRequest): number {
  const resolved =
    typeof req.resolvedAt === "string" ? Date.parse(req.resolvedAt) : Number.NaN;
  if (!Number.isNaN(resolved)) {
    return resolved;
  }
  const created =
    typeof req.createdAt === "string" ? Date.parse(req.createdAt) : Number.NaN;
  return Number.isNaN(created) ? 0 : created;
}

export function listResolvedChangeRequests(
  requests: CloudChangeRequest[],
): CloudChangeRequest[] {
  return requests
    .filter(isResolvedChangeRequest)
    .slice()
    .sort((a, b) => resolvedChangeRequestSortKey(b) - resolvedChangeRequestSortKey(a));
}

export function changeRequestStatusLabel(req: CloudChangeRequest): string {
  const status = typeof req.status === "string" ? req.status.trim() : "";
  if (status === "approved") {
    return "Accepted";
  }
  if (status === "rejected") {
    return "Declined";
  }
  return status || "Unknown";
}

export function isChangeRequestReadyForReview(req: CloudChangeRequest): boolean {
  if (req.status !== "pending") {
    return false;
  }
  const hasHead =
    typeof req.headSha === "string" && req.headSha.trim().length >= 7;
  const hasPr = typeof req.prUrl === "string" && req.prUrl.trim().length > 0;
  return hasHead || hasPr;
}

export function changeRequestStagedPaths(req: CloudChangeRequest): string[] {
  const raw = req.stagedPaths;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .map((p) => p.trim());
}

export function formatChangeRequestCommitRef(req: CloudChangeRequest): string | null {
  const sha =
    typeof req.headSha === "string" ? req.headSha.trim() : "";
  if (sha.length >= 7) {
    return sha.slice(0, 7);
  }
  return null;
}

export function formatChangeRequestBranch(req: CloudChangeRequest): string | null {
  const branch = typeof req.branch === "string" ? req.branch.trim() : "";
  return branch.length > 0 ? branch : null;
}

export interface ChangeRequestSummaryParts {
  narrative: string;
  paths: string[];
  pathsOverflow: number;
  commitRef: string | null;
  branch: string | null;
}

export function buildChangeRequestSummaryParts(
  req: CloudChangeRequest,
): ChangeRequestSummaryParts {
  const narrative =
    typeof req.description === "string" ? req.description.trim() : "";
  const paths = changeRequestStagedPaths(req);
  const listed = paths.slice(0, MAX_LISTED_PATHS);
  const pathsOverflow = Math.max(0, paths.length - listed.length);
  return {
    narrative,
    paths: listed,
    pathsOverflow,
    commitRef: formatChangeRequestCommitRef(req),
    branch: formatChangeRequestBranch(req),
  };
}
