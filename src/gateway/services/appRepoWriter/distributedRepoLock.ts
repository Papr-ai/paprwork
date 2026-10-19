/**
 * Distributed app-repo-writer lock via memory server (Mongo-backed).
 * Composes with in-process withAppRepoLock for same-process serialization.
 */

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { getMemoryServerBaseUrl } from "../../utils/cloudApiClient.js";
import { withAppRepoLock } from "./repoLock.js";

export class WriterLeaseContentionError extends Error {
  constructor(appId: string) {
    super(`Writer lease held for appId=${appId}`);
    this.name = "WriterLeaseContentionError";
  }
}

/**
 * Unique per writer instance. K_REVISION alone is shared by every instance of a
 * revision, so with max-instances > 1 two instances would both "hold" the same
 * lease (same holder re-acquires idempotently). Suffix a per-process id.
 */
export const WRITER_LEASE_HOLDER =
  process.env.PAPR_WRITER_LEASE_HOLDER ??
  `writer:${process.env.K_REVISION ?? hostname()}:${randomUUID().slice(0, 8)}`;

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
