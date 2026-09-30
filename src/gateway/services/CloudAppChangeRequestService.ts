/**
 * Fetch contribute-back change requests from the memory server (owner incoming list).
 */

import { cloudApiFetch } from "../utils/cloudApiClient.js";
import { enrichIncomingChangeRequestsBody } from "./changeRequestContributorEnrich.js";

export interface CloudAppChangeRequestDetail {
  id: string;
  sourceAppId: string;
  sourceSlug?: string;
  installedAppId: string;
  title?: string;
  description?: string;
  status: string;
  branch?: string | null;
  headSha?: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
  stagedPaths?: string[] | null;
  createdAt?: string;
  resolvedAt?: string | null;
}

function normalizeDetail(raw: Record<string, unknown>): CloudAppChangeRequestDetail | null {
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const sourceAppId = typeof raw.sourceAppId === "string" ? raw.sourceAppId.trim() : "";
  const installedAppId =
    typeof raw.installedAppId === "string" ? raw.installedAppId.trim() : "";
  if (!id || !sourceAppId || !installedAppId) {
    return null;
  }
  const stagedRaw = raw.stagedPaths ?? raw.staged_paths;
  const stagedPaths = Array.isArray(stagedRaw)
    ? stagedRaw.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    : null;

  return {
    id,
    sourceAppId,
    sourceSlug: typeof raw.sourceSlug === "string" ? raw.sourceSlug : undefined,
    installedAppId,
    title: typeof raw.title === "string" ? raw.title : undefined,
    description: typeof raw.description === "string" ? raw.description : undefined,
    status: typeof raw.status === "string" ? raw.status : "unknown",
    branch: typeof raw.branch === "string" ? raw.branch : null,
    headSha: typeof raw.headSha === "string" ? raw.headSha : null,
    prUrl: typeof raw.prUrl === "string" ? raw.prUrl : null,
    prNumber: typeof raw.prNumber === "number" ? raw.prNumber : null,
    stagedPaths,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : undefined,
    resolvedAt: typeof raw.resolvedAt === "string" ? raw.resolvedAt : null,
  };
}

export type IncomingChangeRequestStatus =
  | "preparing"
  | "pending"
  | "approved"
  | "rejected";

export interface ListIncomingChangeRequestsOptions {
  status?: IncomingChangeRequestStatus;
  /** Owner upstream app id (matches sourceAppId or installedAppId on the record). */
  appId?: string;
}

async function fetchIncomingChangeRequests(
  status?: IncomingChangeRequestStatus,
): Promise<CloudAppChangeRequestDetail[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  const response = await cloudApiFetch(`/v1/cloud/apps/changes/incoming${query}`);
  if (!response.ok) {
    return [];
  }
  const rawBody = (await response.json()) as { requests?: unknown[] };
  const body = (await enrichIncomingChangeRequestsBody(rawBody)) as {
    requests?: unknown[];
  };
  const out: CloudAppChangeRequestDetail[] = [];
  for (const row of body.requests ?? []) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const normalized = normalizeDetail(row as Record<string, unknown>);
    if (normalized) {
      out.push(normalized);
    }
  }
  return out;
}

function filterByAppId(
  requests: CloudAppChangeRequestDetail[],
  appId: string,
): CloudAppChangeRequestDetail[] {
  const id = appId.trim();
  if (!id) {
    return requests;
  }
  return requests.filter(
    (r) => r.sourceAppId === id || r.installedAppId === id,
  );
}

export class CloudAppChangeRequestService {
  async listIncoming(
    options?: ListIncomingChangeRequestsOptions,
  ): Promise<CloudAppChangeRequestDetail[]> {
    const rows = await fetchIncomingChangeRequests(options?.status);
    if (options?.appId) {
      return filterByAppId(rows, options.appId);
    }
    return rows;
  }

  async getChangeRequest(requestId: string): Promise<CloudAppChangeRequestDetail | null> {
    const trimmed = requestId.trim();
    if (!trimmed) {
      return null;
    }
    const requests = await fetchIncomingChangeRequests();
    return requests.find((r) => r.id === trimmed) ?? null;
  }
}

let instance: CloudAppChangeRequestService | null = null;

export function getCloudAppChangeRequestService(): CloudAppChangeRequestService {
  if (!instance) {
    instance = new CloudAppChangeRequestService();
  }
  return instance;
}

/** @deprecated use CloudAppChangeRequestDetail */
export type ChangeRequestRecord = CloudAppChangeRequestDetail;
