/**
 * Owner incoming contribute-back proposals (memory server via gateway).
 */

import {
  buildMemberLookupByUserId,
  enrichChangeRequestContributorRow,
  extractChangeRequestProposerUserId,
  changeRequestHasContributorDisplayName,
} from "../../src/core/utils/changeRequestContributorEnrich.js";
import {
  contributorFallbackLabel,
  type ContributionAudienceKind,
} from "./contributionPanelCopy";

const GATEWAY =
  typeof import.meta !== "undefined" &&
  import.meta.env?.VITE_GATEWAY_PORT
    ? `http://${import.meta.env.VITE_GATEWAY_HOST || "localhost"}:${import.meta.env.VITE_GATEWAY_PORT || "18789"}`
    : "http://localhost:18789";

export interface CloudChangeRequest {
  id: string;
  sourceAppId: string;
  sourceSlug?: string;
  installedAppId: string;
  title: string;
  description: string;
  status: "preparing" | "pending" | "approved" | "rejected" | string;
  createdAt?: string;
  resolvedAt?: string | null;
  prUrl?: string | null;
  branch?: string | null;
  headSha?: string | null;
  prNumber?: number | null;
  /** Repo paths included in the proposal (when submit recorded them). */
  stagedPaths?: string[] | null;
  /** Memory server may send any of these for the contributor identity */
  contributorDisplayName?: string;
  contributorName?: string;
  contributorEmail?: string;
  proposerDisplayName?: string;
  proposerUserId?: string;
  submitterDisplayName?: string;
  externalUserDisplayName?: string;
  userDisplayName?: string;
  [key: string]: unknown;
}

function parseErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const msg =
      (typeof record.error === "string" && record.error) ||
      (typeof record.detail === "string" && record.detail) ||
      (typeof record.message === "string" && record.message);
    if (msg) {
      return msg.slice(0, 200);
    }
  }
  if (typeof body === "string" && body.trim()) {
    return body.trim().slice(0, 200);
  }
  return `Failed (${status})`;
}

function readChangeRequestString(
  req: CloudChangeRequest,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = req[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

/** Normalize memory-server snake_case onto the fields the UI reads. */
export function normalizeCloudChangeRequest(
  raw: CloudChangeRequest,
): CloudChangeRequest {
  const enriched = enrichChangeRequestContributorRow(
    raw as Record<string, unknown>,
    new Map(),
  ) as CloudChangeRequest;

  const contributorDisplayName =
    readChangeRequestString(enriched, [
      "contributorDisplayName",
      "contributor_display_name",
      "proposerDisplayName",
      "proposer_display_name",
      "submitterDisplayName",
      "submitter_display_name",
      "externalUserDisplayName",
      "external_user_display_name",
      "userDisplayName",
      "user_display_name",
      "contributorName",
      "contributor_name",
      "proposer_name",
    ]) ?? enriched.contributorDisplayName;

  const contributorEmail =
    readChangeRequestString(raw, [
      "contributorEmail",
      "contributor_email",
      "proposerEmail",
      "proposer_email",
    ]) ?? raw.contributorEmail;

  const headSha =
    readChangeRequestString(raw, ["headSha", "head_sha"]) ?? raw.headSha;

  const stagedPathsRaw = raw.stagedPaths ?? raw.staged_paths;
  const stagedPaths = Array.isArray(stagedPathsRaw)
    ? stagedPathsRaw.filter(
        (p): p is string => typeof p === "string" && p.trim().length > 0,
      )
    : raw.stagedPaths;

  const proposerUserId = extractChangeRequestProposerUserId(
    enriched as Record<string, unknown>,
  );

  return {
    ...raw,
    ...enriched,
    contributorDisplayName,
    contributorEmail,
    headSha,
    stagedPaths,
    ...(proposerUserId ? { proposerUserId } : {}),
  };
}

async function enrichRequestsWithWorkspaceMembers(
  requests: CloudChangeRequest[],
): Promise<CloudChangeRequest[]> {
  const needsLookup = requests.some((req) => {
    const raw = req as Record<string, unknown>;
    return (
      !changeRequestHasContributorDisplayName(raw) &&
      Boolean(extractChangeRequestProposerUserId(raw))
    );
  });
  if (!needsLookup) {
    return requests;
  }

  try {
    const res = await fetch(`${GATEWAY}/api/members`);
    if (!res.ok) {
      return requests;
    }
    const body = (await res.json()) as {
      members?: Array<{
        userId?: string;
        displayName?: string;
        email?: string;
      }>;
    };
    const lookup = buildMemberLookupByUserId(body.members ?? []);
    if (lookup.size === 0) {
      return requests;
    }
    return requests.map((req) =>
      normalizeCloudChangeRequest(
        enrichChangeRequestContributorRow(
          req as Record<string, unknown>,
          lookup,
        ) as CloudChangeRequest,
      ),
    );
  } catch {
    return requests;
  }
}

export function contributorLabelForChangeRequest(
  req: CloudChangeRequest,
  audienceKind: ContributionAudienceKind = "community",
): string | null {
  const normalized = normalizeCloudChangeRequest(req);
  const name =
    readChangeRequestString(normalized, [
      "contributorDisplayName",
      "proposerDisplayName",
      "submitterDisplayName",
      "externalUserDisplayName",
      "userDisplayName",
      "contributorName",
    ]) ?? undefined;
  if (name) {
    return name;
  }
  const email = readChangeRequestString(normalized, [
    "contributorEmail",
    "proposerEmail",
  ]);
  if (email) {
    return email;
  }
  const forkId =
    typeof normalized.installedAppId === "string"
      ? normalized.installedAppId.trim()
      : "";
  return contributorFallbackLabel(audienceKind, forkId);
}

function isContributorFallbackLabel(label: string): boolean {
  return (
    label.startsWith("Teammate (") ||
    label.startsWith("Contributor (") ||
    label.startsWith("Collaborator (")
  );
}

/** Owner-facing line naming who sent the proposal. */
export function changeRequestProposedByLine(
  req: CloudChangeRequest,
  audienceKind: ContributionAudienceKind = "community",
): string | null {
  const label = contributorLabelForChangeRequest(req, audienceKind);
  if (!label) {
    return null;
  }
  if (isContributorFallbackLabel(label)) {
    const article =
      audienceKind === "team"
        ? "a teammate"
        : audienceKind === "community"
          ? "a contributor"
          : "a collaborator";
    const detail = label.replace(/^(Teammate|Contributor|Collaborator)\s+/u, "");
    return `Proposed by ${article} ${detail}`;
  }
  switch (audienceKind) {
    case "team":
      return `Proposed by teammate ${label}`;
    case "community":
      return `Proposed by ${label}`;
    case "link":
      return `Proposed by collaborator ${label}`;
  }
}

export async function fetchIncomingCloudChangeRequests(): Promise<
  CloudChangeRequest[]
> {
  const res = await fetch(`${GATEWAY}/api/cloud/apps/changes/incoming`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    throw new Error(parseErrorMessage(body, res.status));
  }
  const requests = (body as { requests?: CloudChangeRequest[] }).requests ?? [];
  const normalized = requests.map(normalizeCloudChangeRequest);
  return enrichRequestsWithWorkspaceMembers(normalized);
}

export async function resolveCloudChangeRequest(
  requestId: string,
  action: "approve" | "reject",
): Promise<void> {
  const res = await fetch(
    `${GATEWAY}/api/cloud/apps/changes/${encodeURIComponent(requestId)}/${action}`,
    { method: "POST" },
  );
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    throw new Error(parseErrorMessage(body, res.status));
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("gateway-broadcast", {
        detail: { type: "cloud-change-requests:stale" },
      }),
    );
  }
}
