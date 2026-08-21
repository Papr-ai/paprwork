/**
 * Fetch per-app GitHub repo metadata from memory server (RepoRegistry).
 * Clients must never construct repo URLs — server assigns shard org + repo name.
 */

import type { AppRepoRecord } from "../../../core/types/appRepoRegistry.js";
import { parseAppRepoRecord } from "../../../core/types/appRepoRegistry.js";
import { cloudApiFetch } from "../../utils/cloudApiClient.js";
import {
  getCachedAppRepoRecord,
  upsertCachedAppRepoRecord,
} from "./appRepoRegistryCache.js";
export class AppRepoNotFoundError extends Error {
  constructor(appId: string) {
    super(`App repo not found for appId=${appId}`);
    this.name = "AppRepoNotFoundError";
  }
}

export class AppRepoApiError extends Error {
  readonly status: number;

  constructor(appId: string, status: number, detail: string) {
    super(
      `App repo API failed for appId=${appId} (${status}): ${detail.slice(0, 200)}`,
    );
    this.name = "AppRepoApiError";
    this.status = status;
  }
}

function repoPath(appId: string): string {
  return `/v1/cloud/apps/${encodeURIComponent(appId)}/repo`;
}

async function fetchAppRepoRecord(
  appId: string,
  method: "GET" | "POST",
): Promise<AppRepoRecord> {
  const resp = await cloudApiFetch(
    method === "POST" ? `${repoPath(appId)}/ensure` : repoPath(appId),
    {
      method,
      body: method === "POST" ? {} : undefined,
      timeoutMs: 60_000,
    },
  );

  if (resp.status === 404) {
    throw new AppRepoNotFoundError(appId);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new AppRepoApiError(appId, resp.status, text);
  }

  const payload: unknown = await resp.json();
  const record = parseAppRepoRecord(payload);
  if (record.appId !== appId) {
    throw new Error(
      `App repo response appId mismatch: expected ${appId}, got ${record.appId}`,
    );
  }
  await upsertCachedAppRepoRecord(record);
  return record;
}

/** Read cached record or fetch from GET /repo (no create). */
export async function getAppRepoRecord(appId: string): Promise<AppRepoRecord | null> {
  const trimmed = appId.trim();
  if (!trimmed) {
    return null;
  }

  const cached = await getCachedAppRepoRecord(trimmed);
  if (cached) {
    return cached;
  }

  try {
    return await fetchAppRepoRecord(trimmed, "GET");
  } catch (err) {
    if (err instanceof AppRepoNotFoundError) {
      return null;
    }
    throw err;
  }
}

/** Idempotent ensure — POST /repo/ensure (creates shard repo if needed). */
export async function ensureAppRepoRecord(appId: string): Promise<AppRepoRecord> {
  const trimmed = appId.trim();
  if (!trimmed) {
    throw new Error("appId is required for ensureAppRepoRecord");
  }
  return fetchAppRepoRecord(trimmed, "POST");
}

/** Resolve per-app repo metadata; null if server has no record yet. */
export async function resolveAppRepoForSync(
  appId: string,
): Promise<AppRepoRecord | null> {
  try {
    return await ensureAppRepoRecord(appId);
  } catch (err) {
    if (err instanceof AppRepoNotFoundError) {
      console.warn(
        `[SyncV3] Per-app repo not registered yet for ${appId} — using namespace monorepo until migration`,
      );
      return null;
    }
    if (err instanceof AppRepoApiError && err.status === 404) {
      return null;
    }
    console.warn(
      `[SyncV3] ensureAppRepo failed for ${appId}:`,
      (err as Error).message.slice(0, 120),
    );
    return null;
  }
}

/** Best-effort validate server-provided clone URL matches registry record. */
export function cloneUrlMatchesAppRepo(
  cloneUrl: string,
  record: AppRepoRecord,
): boolean {
  const normalize = (url: string): string =>
    url.replace(/^https:\/\/x-access-token:[^@]+@/i, "https://").replace(/\.git$/, "");
  return normalize(cloneUrl) === normalize(record.cloneUrl);
}
