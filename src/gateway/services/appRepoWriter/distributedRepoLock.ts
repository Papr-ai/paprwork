/**
 * Distributed app-repo-writer lock via memory server (Mongo-backed).
 * Composes with in-process withAppRepoLock for same-process serialization.
 */

import { hostname } from "node:os";
import { getMemoryServerBaseUrl } from "../../utils/cloudApiClient.js";
import { withAppRepoLock } from "./repoLock.js";

export class WriterLeaseContentionError extends Error {
  constructor(appId: string) {
    super(`Writer lease held for appId=${appId}`);
    this.name = "WriterLeaseContentionError";
  }
}

/** Unique per writer instance (Cloud Run revision or local hostname). */
export const WRITER_LEASE_HOLDER =
  process.env.PAPR_WRITER_LEASE_HOLDER ??
  (process.env.K_REVISION
    ? `writer:${process.env.K_REVISION}`
    : `writer:${hostname()}`);

interface AcquireResponse {
  acquired: boolean;
  token?: string;
}

async function acquireWriterLease(
  appId: string,
  apiKey: string,
): Promise<{ acquired: boolean; token?: string }> {
  const resp = await fetch(
    `${getMemoryServerBaseUrl()}/v1/cloud/apps/${encodeURIComponent(appId)}/writer-lease/acquire`,
    {
      method: "POST",
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ holder: WRITER_LEASE_HOLDER }),
    },
  );
  if (resp.status === 409 || resp.status === 423) {
    return { acquired: false };
  }
  if (!resp.ok) {
    const text = await resp.text();
    console.warn(
      `[DistributedRepoLock] acquire failed (${resp.status}) app=${appId}: ${text.slice(0, 120)}`,
    );
    return { acquired: true };
  }
  const data = (await resp.json()) as AcquireResponse;
  return { acquired: data.acquired, token: data.token };
}

async function releaseWriterLease(
  appId: string,
  apiKey: string,
  token: string,
): Promise<void> {
  try {
    await fetch(
      `${getMemoryServerBaseUrl()}/v1/cloud/apps/${encodeURIComponent(appId)}/writer-lease/release`,
      {
        method: "POST",
        headers: {
          "X-API-Key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token, holder: WRITER_LEASE_HOLDER }),
      },
    );
  } catch (err) {
    console.warn(`[DistributedRepoLock] release error app=${appId}:`, err);
  }
}

export async function withDistributedAppRepoLock<T>(
  appId: string,
  apiKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lease = await acquireWriterLease(appId, apiKey);
  if (!lease.acquired) {
    throw new WriterLeaseContentionError(appId);
  }
  try {
    return await withAppRepoLock(appId, fn);
  } finally {
    if (lease.token) {
      await releaseWriterLease(appId, apiKey, lease.token);
    }
  }
}
