/**
 * Dual-write namespace metadata registries to Mongo (Phase 4.6).
 * Failures are queued in metadataOutbox for heartbeat retry.
 */

import { cloudApiFetch } from "../../utils/cloudApiClient.js";
import { getPaprApiKey } from "../../utils/keyResolver.js";
import type { CloudAppMetaFile } from "../cloudSync/cloudAppMeta.js";
import type { DatabasesRegistryFile } from "../DatabaseRegistryService.js";
import type { JobConfigSlice } from "../jobs/jobRuntimeFields.js";
import { enqueueMetadataOutboxEntry, flushMetadataOutbox } from "./metadataOutbox.js";

export interface MetadataUpsertResponse {
  accepted: boolean;
  source?: string;
}

export async function uploadJobsIndexToCloudDirect(
  jobs: JobConfigSlice[],
  updatedAt: string,
): Promise<boolean> {
  const apiKey = await getPaprApiKey();
  if (!apiKey) {
    return false;
  }

  const res = await cloudApiFetch("/v1/cloud/metadata/jobs", {
    method: "PUT",
    body: { jobs, updatedAt },
    timeoutMs: 15_000,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`jobs index upload failed (${res.status}): ${text.slice(0, 120)}`);
  }
  const body = (await res.json()) as MetadataUpsertResponse;
  return body.accepted !== false;
}

export async function uploadDatabasesRegistryToCloudDirect(
  registry: DatabasesRegistryFile,
  updatedAt: string,
): Promise<boolean> {
  const apiKey = await getPaprApiKey();
  if (!apiKey) {
    return false;
  }

  const res = await cloudApiFetch("/v1/cloud/metadata/databases", {
    method: "PUT",
    body: { registry, updatedAt },
    timeoutMs: 15_000,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `databases registry upload failed (${res.status}): ${text.slice(0, 120)}`,
    );
  }
  const body = (await res.json()) as MetadataUpsertResponse;
  return body.accepted !== false;
}

export async function uploadAppRuntimeMetaToCloudDirect(
  appId: string,
  meta: CloudAppMetaFile,
): Promise<boolean> {
  const apiKey = await getPaprApiKey();
  if (!apiKey) {
    return false;
  }

  const res = await cloudApiFetch(
    `/v1/cloud/metadata/apps/${encodeURIComponent(appId)}/runtime-meta`,
    {
      method: "PUT",
      body: {
        schemaVersion: meta.schemaVersion,
        distRevision: meta.distRevision,
        requiredSchemaVersion: meta.requiredSchemaVersion,
        updatedAt: meta.updatedAt ?? new Date().toISOString(),
      },
      timeoutMs: 15_000,
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `app runtime meta upload failed (${res.status}): ${text.slice(0, 120)}`,
    );
  }
  const body = (await res.json()) as MetadataUpsertResponse;
  return body.accepted !== false;
}

export async function uploadAppRuntimeMetaToCloud(
  appId: string,
  meta: CloudAppMetaFile,
): Promise<boolean> {
  try {
    const ok = await uploadAppRuntimeMetaToCloudDirect(appId, meta);
    if (!ok) {
      await enqueueMetadataOutboxEntry({
        kind: "app-runtime-meta",
        updatedAt: meta.updatedAt ?? new Date().toISOString(),
        appId,
        appRuntimeMeta: meta,
      });
    }
    return ok;
  } catch (err) {
    console.warn(
      "[MetadataRegistry] app runtime meta upload error:",
      (err as Error).message.slice(0, 120),
    );
    await enqueueMetadataOutboxEntry({
      kind: "app-runtime-meta",
      updatedAt: meta.updatedAt ?? new Date().toISOString(),
      appId,
      appRuntimeMeta: meta,
    });
    return false;
  }
}

export async function uploadJobsIndexToCloud(
  jobs: JobConfigSlice[],
  updatedAt: string,
): Promise<boolean> {
  try {
    const ok = await uploadJobsIndexToCloudDirect(jobs, updatedAt);
    if (!ok) {
      await enqueueMetadataOutboxEntry({ kind: "jobs", updatedAt, jobs });
    }
    return ok;
  } catch (err) {
    console.warn(
      "[MetadataRegistry] jobs index upload error:",
      (err as Error).message.slice(0, 120),
    );
    await enqueueMetadataOutboxEntry({ kind: "jobs", updatedAt, jobs });
    return false;
  }
}

export async function uploadDatabasesRegistryToCloud(
  registry: DatabasesRegistryFile,
  updatedAt: string,
): Promise<boolean> {
  try {
    const ok = await uploadDatabasesRegistryToCloudDirect(registry, updatedAt);
    if (!ok) {
      await enqueueMetadataOutboxEntry({ kind: "databases", updatedAt, registry });
    }
    return ok;
  } catch (err) {
    console.warn(
      "[MetadataRegistry] databases registry upload error:",
      (err as Error).message.slice(0, 120),
    );
    await enqueueMetadataOutboxEntry({ kind: "databases", updatedAt, registry });
    return false;
  }
}

export async function retryPendingMetadataUploads(): Promise<void> {
  const result = await flushMetadataOutbox();
  if (result.flushed > 0) {
    console.log(
      `[MetadataRegistry] Flushed ${result.flushed} queued metadata upload(s)`,
    );
  }
}
