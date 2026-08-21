/**
 * POST app ops to app-repo-writer (Sync V3 Phase 2).
 */

import type {
  AppRepoHeadResponse,
  AppRepoOpsConflictResponse,
  AppRepoOpsRequest,
  AppRepoOpsSuccessResponse,
} from "../../../core/types/appRepoWriterOps.js";
import {
  AppRepoHeadResponseSchema,
  AppRepoOpsConflictResponseSchema,
  AppRepoOpsSuccessResponseSchema,
} from "../../../core/types/appRepoWriterOps.js";
import { getPaprApiKey } from "../../utils/keyResolver.js";
import { applyAckedBlobOids, seedOidCacheFromHead } from "./OidCache.js";
import { getAppRepoWriterBaseUrl } from "./writerConfig.js";
import { incrementSyncV3Metric } from "./syncV3Metrics.js";
import { invalidateWriterConflictPaths } from "./writerConflict.js";

/** Large apps (esbuild + Turso + many files) can exceed 2 minutes before writer POST. */
export const WRITER_FETCH_TIMEOUT_MS = 300_000;

export class AppOpsConflictError extends Error {
  readonly appId: string;
  readonly artifacts: AppRepoOpsConflictResponse["artifacts"];

  constructor(appId: string, response: AppRepoOpsConflictResponse) {
    super(
      `Writer conflict for app ${appId}: ${response.artifacts
        .map((artifact) => artifact.path)
        .join(", ")}`,
    );
    this.name = "AppOpsConflictError";
    this.appId = appId;
    this.artifacts = response.artifacts;
  }
}

export class AppOpsClientError extends Error {
  readonly status: number;

  constructor(appId: string, status: number, detail: string) {
    super(`Writer ops failed for ${appId} (${status}): ${detail.slice(0, 300)}`);
    this.name = "AppOpsClientError";
    this.status = status;
  }
}

async function writerFetch(
  route: string,
  init: RequestInit,
): Promise<Response> {
  const apiKey = await getPaprApiKey();
  if (!apiKey) {
    throw new Error("PAPR_API_KEY not configured. Login with Papr first.");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": apiKey,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WRITER_FETCH_TIMEOUT_MS);
  try {
    return await fetch(`${getAppRepoWriterBaseUrl()}${route}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string>) },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new AppOpsClientError(
        "writer",
        408,
        `Writer request timed out after ${Math.round(WRITER_FETCH_TIMEOUT_MS / 1000)}s`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAppRepoHead(appId: string): Promise<AppRepoHeadResponse> {
  const resp = await writerFetch(
    `/apps/${encodeURIComponent(appId)}/head`,
    { method: "GET" },
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new AppOpsClientError(appId, resp.status, text);
  }
  const payload: unknown = await resp.json();
  const parsed = AppRepoHeadResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppOpsClientError(appId, 502, "invalid head response shape");
  }
  await seedOidCacheFromHead(appId, parsed.data.files);
  return parsed.data;
}

export async function postAppOps(
  appId: string,
  body: AppRepoOpsRequest,
): Promise<AppRepoOpsSuccessResponse> {
  const resp = await writerFetch(
    `/apps/${encodeURIComponent(appId)}/ops`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );

  if (resp.status === 409) {
    const payload: unknown = await resp.json();
    const parsed = AppRepoOpsConflictResponseSchema.safeParse(payload);
    if (parsed.success) {
      incrementSyncV3Metric("writer_conflict_count");
      await invalidateWriterConflictPaths(appId, parsed.data.artifacts);
      throw new AppOpsConflictError(appId, parsed.data);
    }
    throw new AppOpsClientError(appId, 409, JSON.stringify(payload));
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new AppOpsClientError(appId, resp.status, text);
  }

  const payload: unknown = await resp.json();
  const parsed = AppRepoOpsSuccessResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppOpsClientError(appId, 502, "invalid ops success response shape");
  }

  incrementSyncV3Metric("v3_op_count");
  await applyAckedBlobOids(appId, parsed.data.files);
  return parsed.data;
}
