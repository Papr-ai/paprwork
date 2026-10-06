/**
 * POST app ops to app-repo-writer (Sync V3 Phase 2).
 */

import { assertGitHubNotPaused, noteGitHubRateLimit } from "../githubRateGate.js";
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
import {
  applyAckedBlobOids,
  removeCachedPaths,
  seedOidCacheFromHead,
} from "./OidCache.js";
import { updateSyncManifest } from "./SyncManifest.js";
import { getAppRepoWriterBaseUrl, isLocalAppRepoWriter } from "./writerConfig.js";
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

  assertGitHubNotPaused();
  const baseUrl = getAppRepoWriterBaseUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WRITER_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(`${baseUrl}${route}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string>) },
      signal: controller.signal,
    });
    if (resp.status === 429 && resp.headers?.get?.("retry-after")) {
      // The writer relays GitHub's limit as 429 + Retry-After; pause every
      // process, not just this one. Headers only — the body stays unread for
      // the caller's own error handling.
      noteGitHubRateLimit(resp.status, resp.headers, "", "app-repo-writer");
    }
    return resp;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new AppOpsClientError(
        "writer",
        408,
        `Writer request timed out after ${Math.round(WRITER_FETCH_TIMEOUT_MS / 1000)}s`,
      );
    }
    // Bare `fetch failed` hides the URL, so a wrong/unreachable writer looks
    // like a generic sync bug. Name the host and the likely cause.
    const cause = err instanceof Error ? err.message : String(err);
    const hint = isLocalAppRepoWriter()
      ? " Local writer is not running — start it with `npm run start:app-repo-writer`, or unset PAPR_APP_REPO_WRITER_URL to use the Papr Cloud writer."
      : " Check your network connection and try Publish changes again.";
    throw new AppOpsClientError(
      "writer",
      503,
      `Cannot reach app-repo-writer at ${baseUrl}: ${cause}.${hint}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

const headInflight = new Map<string, Promise<AppRepoHeadResponse>>();

export async function fetchAppRepoHead(
  appId: string,
  options?: { seedOidCache?: boolean },
): Promise<AppRepoHeadResponse> {
  const trimmed = appId.trim();
  const inflight = headInflight.get(trimmed);
  if (inflight) {
    return inflight;
  }

  const request = (async (): Promise<AppRepoHeadResponse> => {
    const resp = await writerFetch(
      `/apps/${encodeURIComponent(trimmed)}/head`,
      { method: "GET" },
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new AppOpsClientError(trimmed, resp.status, text);
    }
    const payload: unknown = await resp.json();
    const parsed = AppRepoHeadResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AppOpsClientError(trimmed, 502, "invalid head response shape");
    }
    if (options?.seedOidCache !== false) {
      await seedOidCacheFromHead(trimmed, parsed.data.files);
    }
    return parsed.data;
  })();

  headInflight.set(trimmed, request);
  try {
    return await request;
  } finally {
    headInflight.delete(trimmed);
  }
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
      const settled = await settleAlreadyAppliedConflicts(appId, body, parsed.data);
      if (settled) {
        return settled;
      }
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
  // Acks list written blobs only; a deleted path has none, so drop it here or
  // the status panel keeps reporting it as removed.
  const deleted = body.files.filter((f) => f.content === null).map((f) => f.path);
  await removeCachedPaths(appId, deleted);
  // Both sides now hold exactly these bytes (or neither has the file).
  await updateSyncManifest(appId, {
    add: parsed.data.files.map((f) => ({ path: f.path, oid: f.blobOid })),
    remove: deleted,
  });
  const { writeAppRepoCommitCursor } = await import("./appRepoCommittedFanout.js");
  await writeAppRepoCommitCursor(appId, parsed.data.commitSha);
  const { rememberOwnAppCommit } = await import("./appRepoPendingUpdate.js");
  rememberOwnAppCommit(appId, parsed.data.commitSha);
  try {
    const { realignLocalAppCodeBaseline } = await import("./appRepoHeadSyncCheck.js");
    await realignLocalAppCodeBaseline(appId);
  } catch {
    // Non-fatal — ack OIDs + cursor are enough when HEAD is not yet visible.
  }
  return parsed.data;
}

/**
 * A "conflict" where cloud HEAD already holds exactly the bytes we are sending
 * is not a conflict: an earlier upload committed, but its ack was lost (e.g.
 * the app restarted mid-publish), so our parentHash is stale. Adopt cloud's
 * blob OIDs and send whatever else is left. Returns null for real conflicts.
 */
async function settleAlreadyAppliedConflicts(
  appId: string,
  body: AppRepoOpsRequest,
  conflict: AppRepoOpsConflictResponse,
): Promise<AppRepoOpsSuccessResponse | null> {
  const { computeBlobOidForContent } = await import("./computeParentHash.js");
  const settledPaths = new Set<string>();
  const settledFiles: Array<{ path: string; blobOid: string }> = [];
  for (const artifact of conflict.artifacts) {
    const file = body.files.find((f) => f.path === artifact.path);
    if (!file) {
      return null;
    }
    if (file.content === null) {
      if (artifact.actualBlobOid !== null) return null; // still exists on cloud
      settledPaths.add(file.path);
      continue;
    }
    const oid = await computeBlobOidForContent(file.content);
    if (oid !== artifact.actualBlobOid) {
      return null; // cloud really differs
    }
    settledPaths.add(file.path);
    settledFiles.push({ path: file.path, blobOid: oid });
  }

  console.log(
    `[AppOps] ${appId}: ${settledPaths.size} "conflict" path(s) already match cloud HEAD — adopting cloud OIDs`,
  );
  await applyAckedBlobOids(appId, settledFiles);
  const settledDeletes = body.files
    .filter((f) => f.content === null && settledPaths.has(f.path))
    .map((f) => f.path);
  await removeCachedPaths(appId, settledDeletes);
  await updateSyncManifest(appId, {
    add: settledFiles.map((f) => ({ path: f.path, oid: f.blobOid })),
    remove: settledDeletes,
  });
  const remaining = body.files.filter((f) => !settledPaths.has(f.path));
  if (remaining.length > 0) {
    const ack = await postAppOps(appId, {
      ...body,
      files: remaining,
      idempotencyKey: `${body.idempotencyKey}:settled`,
    });
    return { ...ack, files: [...settledFiles, ...ack.files] };
  }
  // Nothing new to commit — cloud HEAD is the commit that already holds our bytes.
  const head = await fetchAppRepoHead(appId);
  return { commitSha: head.commitSha, files: settledFiles };
}
