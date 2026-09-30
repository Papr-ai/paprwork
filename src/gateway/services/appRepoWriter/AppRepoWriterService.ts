/**
 * app-repo-writer core orchestration.
 */

import type { AppRepoRecord } from "../../../core/types/appRepoRegistry.js";
import { parseAppRepoRecord } from "../../../core/types/appRepoRegistry.js";
import type {
  AppRepoOpsRequest,
  AppRepoOpsSuccessResponse,
} from "../../../core/types/appRepoWriterOps.js";
import { AppRepoOpsRequestSchema } from "../../../core/types/appRepoWriterOps.js";
import { getMemoryServerBaseUrl } from "../../utils/cloudApiClient.js";
import { filterAbusiveOpFiles } from "./abuseFilter.js";
import { applyAppRepoOps, readAppRepoHead } from "./githubWorktree.js";
import {
  getIdempotentOpsResponse,
  storeIdempotentOpsResponse,
} from "./idempotencyCache.js";
import { publishAppRepoCommitted } from "./pubsubNotify.js";
import { withDistributedAppRepoLock, WriterLeaseContentionError } from "./distributedRepoLock.js";

export class WriterAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriterAuthError";
  }
}

export class WriterRepoNotFoundError extends Error {
  constructor(appId: string) {
    super(`App repo not found for appId=${appId}`);
    this.name = "WriterRepoNotFoundError";
  }
}

async function fetchAppRepoRecord(
  appId: string,
  apiKey: string,
): Promise<AppRepoRecord> {
  const resp = await fetch(
    `${getMemoryServerBaseUrl()}/v1/cloud/apps/${encodeURIComponent(appId)}/repo`,
    {
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
      },
    },
  );
  if (resp.status === 404) {
    throw new WriterRepoNotFoundError(appId);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`RepoRegistry lookup failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  const payload: unknown = await resp.json();
  return parseAppRepoRecord(payload);
}

export class AppRepoWriterService {
  async getHead(
    appId: string,
    apiKey: string,
  ): Promise<{ commitSha: string; files: Array<{ path: string; blobOid: string }> }> {
    const record = await fetchAppRepoRecord(appId, apiKey);
    return readAppRepoHead(record);
  }

  async postOps(
    appId: string,
    apiKey: string,
    body: unknown,
  ): Promise<
    | { ok: true; response: AppRepoOpsSuccessResponse }
    | {
        ok: false;
        status: number;
        body: Record<string, unknown>;
      }
  > {
    const parsed = AppRepoOpsRequestSchema.safeParse(body);
    if (!parsed.success) {
      return {
        ok: false,
        status: 400,
        body: { error: parsed.error.message },
      };
    }

    const request: AppRepoOpsRequest = parsed.data;
    const cached = getIdempotentOpsResponse(appId, request.idempotencyKey);
    if (cached) {
      return { ok: true, response: cached };
    }

    const { accepted, rejected } = filterAbusiveOpFiles(request.files);
    if (rejected.length > 0) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "abusive or blocked files in op",
          rejected,
        },
      };
    }
    if (accepted.length === 0) {
      return {
        ok: false,
        status: 400,
        body: { error: "no acceptable files in op" },
      };
    }

    const record = await fetchAppRepoRecord(appId, apiKey);

    try {
      const result = await withDistributedAppRepoLock(appId, apiKey, () =>
        applyAppRepoOps(record, accepted, request.message, request.author),
      );

      const response: AppRepoOpsSuccessResponse = {
        commitSha: result.commitSha,
        files: result.files,
      };
      storeIdempotentOpsResponse(appId, request.idempotencyKey, response);
      await publishAppRepoCommitted({
        appId,
        commitSha: result.commitSha,
        githubOrg: record.githubOrg,
        repoName: record.repoName,
        namespaceId: record.namespaceId,
        committedAt: new Date().toISOString(),
      });
      return { ok: true, response };
    } catch (err) {
      if (err instanceof WriterLeaseContentionError) {
        return {
          ok: false,
          status: 423,
          body: { error: err.message, retryable: true },
        };
      }
      const mismatches = (err as Error & { mismatches?: Array<{
        path: string;
        expectedParentHash: string;
        actualBlobOid: string | null;
      }> }).mismatches;
      if (mismatches && mismatches.length > 0) {
        return {
          ok: false,
          status: 409,
          body: {
            conflict: true,
            artifacts: mismatches.map((artifact) => ({
              path: artifact.path,
              expectedParentHash: artifact.expectedParentHash,
              actualBlobOid: artifact.actualBlobOid,
            })),
          },
        };
      }
      throw err;
    }
  }
}

let serviceInstance: AppRepoWriterService | null = null;

export function getAppRepoWriterService(): AppRepoWriterService {
  if (!serviceInstance) {
    serviceInstance = new AppRepoWriterService();
  }
  return serviceInstance;
}
