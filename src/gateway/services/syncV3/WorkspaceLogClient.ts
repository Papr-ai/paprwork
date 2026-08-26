/**
 * Desktop client for memory server workspace log API (Phase 3).
 * Memory server is sole append authority — desktop never writes oplog directly.
 */

import type {
  WorkspaceLogAppendBatchRequest,
  WorkspaceLogAppendBatchResponse,
  WorkspaceLogAppendRequest,
  WorkspaceLogAppendResponse,
  WorkspaceLogGenesisRequest,
  WorkspaceLogSinceResponse,
} from "../../../core/types/workspaceLog.js";
import { cloudApiFetch, getMemoryServerBaseUrl } from "../../utils/cloudApiClient.js";
import { mergeCloudActingUserBody } from "../../utils/cloudActingUser.js";
import { recordSyncV3Gauge } from "./syncV3Metrics.js";

export class WorkspaceLogApiError extends Error {
  readonly status: number;

  constructor(replicaId: string, status: number, detail: string) {
    super(
      `Workspace log API failed for replica=${replicaId} (${status}): ${detail.slice(0, 200)}`,
    );
    this.name = "WorkspaceLogApiError";
    this.status = status;
  }
}

async function parseJsonResponse<T>(resp: Response, replicaId: string): Promise<T> {
  if (!resp.ok) {
    const text = await resp.text();
    throw new WorkspaceLogApiError(replicaId, resp.status, text);
  }
  return (await resp.json()) as T;
}

export async function appendWorkspaceLogEntry(
  request: WorkspaceLogAppendRequest,
): Promise<WorkspaceLogAppendResponse> {
  const started = performance.now();
  const resp = await cloudApiFetch("/v1/cloud/workspace/log/append", {
    method: "POST",
    body: request,
    timeoutMs: 30_000,
  });
  const result = await parseJsonResponse<WorkspaceLogAppendResponse>(
    resp,
    request.replicaId,
  );
  const latencyMs = Math.round(performance.now() - started);
  if (latencyMs > 0) {
    recordOplogAppendLatency(latencyMs);
  }
  return result;
}

/** Max row ops per HTTP request (must match memory server `_MAX_BATCH_ENTRIES`). */
export const WORKSPACE_LOG_SHIP_BATCH_SIZE = 500;

export async function appendWorkspaceLogBatch(
  request: WorkspaceLogAppendBatchRequest,
  options?: { timeoutMs?: number },
): Promise<WorkspaceLogAppendBatchResponse> {
  const started = performance.now();
  const timeoutMs =
    options?.timeoutMs ??
    Math.min(180_000, 45_000 + request.entries.length * 250);
  const resp = await cloudApiFetch("/v1/cloud/workspace/log/append-batch", {
    method: "POST",
    body: request,
    timeoutMs,
  });
  const result = await parseJsonResponse<WorkspaceLogAppendBatchResponse>(
    resp,
    request.replicaId,
  );
  const latencyMs = Math.round(performance.now() - started);
  if (latencyMs > 0) {
    recordOplogAppendLatency(latencyMs);
  }
  return result;
}

/** Maintenance scripts — explicit API key (namespace vault / legacy keys). */
export async function appendWorkspaceLogEntryWithApiKey(
  request: WorkspaceLogAppendRequest,
  apiKey: string,
): Promise<WorkspaceLogAppendResponse> {
  const started = performance.now();
  const resp = await fetch(
    `${getMemoryServerBaseUrl()}/v1/cloud/workspace/log/append`,
    {
      method: "POST",
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        mergeCloudActingUserBody(
          request as unknown as Record<string, unknown>,
        ),
      ),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const result = await parseJsonResponse<WorkspaceLogAppendResponse>(
    resp,
    request.replicaId,
  );
  const latencyMs = Math.round(performance.now() - started);
  if (latencyMs > 0) {
    recordOplogAppendLatency(latencyMs);
  }
  return result;
}

/** Default GET timeout for workspace log pages (large replays can be slow). */
export const WORKSPACE_LOG_READ_TIMEOUT_MS = 300_000;

export async function readWorkspaceLogSince(
  replicaId: string,
  cursor: number,
  limit = 500,
  options?: { timeoutMs?: number },
): Promise<WorkspaceLogSinceResponse> {
  const qs = new URLSearchParams({
    replicaId,
    cursor: String(cursor),
    limit: String(limit),
  });
  const resp = await cloudApiFetch(`/v1/cloud/workspace/log/since?${qs.toString()}`, {
    method: "GET",
    timeoutMs: options?.timeoutMs ?? WORKSPACE_LOG_READ_TIMEOUT_MS,
  });
  return parseJsonResponse<WorkspaceLogSinceResponse>(resp, replicaId);
}

export async function writeWorkspaceLogGenesis(
  request: WorkspaceLogGenesisRequest,
): Promise<WorkspaceLogAppendResponse> {
  const resp = await cloudApiFetch("/v1/cloud/workspace/log/genesis", {
    method: "POST",
    body: request,
    timeoutMs: 60_000,
  });
  return parseJsonResponse<WorkspaceLogAppendResponse>(resp, request.replicaId);
}

/** Track p99-ish append latency for observability (simple max-of-window). */
let lastAppendLatencyMs = 0;

function recordOplogAppendLatency(latencyMs: number): void {
  if (latencyMs >= lastAppendLatencyMs) {
    lastAppendLatencyMs = latencyMs;
    recordSyncV3Gauge("oplog_append_latency_p99", latencyMs);
  }
}

export function getLastOplogAppendLatencyMsForTests(): number {
  return lastAppendLatencyMs;
}

export function resetOplogAppendLatencyForTests(): void {
  lastAppendLatencyMs = 0;
}
