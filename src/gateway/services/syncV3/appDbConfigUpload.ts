/**
 * Dual-write per-app data-sources.json + linked-databases.json to Mongo (Phase 3).
 */

import * as fs from "fs";
import * as path from "path";
import { LINKED_DATABASES_FILENAME } from "../cloudSync/linkedDatabasesForCloud.js";
import { cloudApiFetch } from "../../utils/cloudApiClient.js";
import { getPaprApiKey } from "../../utils/keyResolver.js";
import { enqueueMetadataOutboxEntry } from "./metadataOutbox.js";
import type { MetadataUpsertResponse } from "./MetadataRegistryClient.js";

export interface AppDbConfigPayload {
  dataSources: string;
  linkedDatabases: string;
  updatedAt: string;
  commitSha?: string;
}

export async function readAppDbConfigFromDisk(
  paprDir: string,
  appId: string,
): Promise<AppDbConfigPayload | null> {
  const appDir = path.join(paprDir, "apps", appId);
  const dataSourcesPath = path.join(appDir, "data-sources.json");
  if (!fs.existsSync(dataSourcesPath)) {
    return null;
  }

  const dataSources = fs.readFileSync(dataSourcesPath, "utf8");
  const linkedPath = path.join(appDir, LINKED_DATABASES_FILENAME);
  const linkedDatabases = fs.existsSync(linkedPath)
    ? fs.readFileSync(linkedPath, "utf8")
    : `${JSON.stringify({ databases: {} }, null, 2)}\n`;

  return {
    dataSources,
    linkedDatabases,
    updatedAt: new Date().toISOString(),
  };
}

export async function uploadAppDbConfigToCloudDirect(
  appId: string,
  payload: AppDbConfigPayload,
  options?: { timeoutMs?: number },
): Promise<boolean> {
  const apiKey = await getPaprApiKey();
  if (!apiKey) {
    return false;
  }

  const res = await cloudApiFetch(
    `/v1/cloud/metadata/apps/${encodeURIComponent(appId)}/db-config`,
    {
      method: "PUT",
      body: {
        dataSources: payload.dataSources,
        linkedDatabases: payload.linkedDatabases,
        updatedAt: payload.updatedAt,
        commitSha: payload.commitSha,
      },
      timeoutMs: options?.timeoutMs ?? 15_000,
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `app db config upload failed (${res.status}): ${text.slice(0, 120)}`,
    );
  }
  const body = (await res.json()) as MetadataUpsertResponse;
  return body.accepted !== false;
}

export async function uploadAppDbConfigToCloud(
  paprDir: string,
  appId: string,
  commitSha?: string,
  options?: { timeoutMs?: number },
): Promise<boolean> {
  const payload = await readAppDbConfigFromDisk(paprDir, appId);
  if (!payload) {
    return false;
  }
  if (commitSha) {
    payload.commitSha = commitSha;
  }

  try {
    const ok = await uploadAppDbConfigToCloudDirect(appId, payload, options);
    if (!ok) {
      await enqueueMetadataOutboxEntry({
        kind: "app-db-config",
        updatedAt: payload.updatedAt,
        appId,
        appDbConfig: payload,
      });
    }
    return ok;
  } catch (err) {
    console.warn(
      "[MetadataRegistry] app db config upload error:",
      (err as Error).message.slice(0, 120),
    );
    await enqueueMetadataOutboxEntry({
      kind: "app-db-config",
      updatedAt: payload.updatedAt,
      appId,
      appDbConfig: payload,
    });
    return false;
  }
}
