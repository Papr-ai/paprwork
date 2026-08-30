/**
 * Push namespace databases.json + per-app db config to Mongo before web publish.
 * Git/repo files are source of truth; Mongo must match after every flush.
 */

import * as fs from "fs";
import * as path from "path";
import type { DatabasesRegistryFile } from "../DatabaseRegistryService.js";
import { DATABASES_REGISTRY_FILENAME } from "../DatabaseRegistryService.js";
import { uploadAppDbConfigToCloud } from "./appDbConfigUpload.js";
import { uploadDatabasesRegistryToCloud } from "./MetadataRegistryClient.js";
import { flushMetadataOutbox } from "./metadataOutbox.js";
import { yieldEventLoop } from "../cloudSync/yieldEventLoop.js";

const METADATA_FLUSH_TIMEOUT_MS = 60_000;
const METADATA_OUTBOX_RETRY_ATTEMPTS = 3;
const METADATA_OUTBOX_RETRY_DELAY_MS = 2_000;

async function retryQueuedMetadataUploads(): Promise<boolean> {
  for (let attempt = 0; attempt < METADATA_OUTBOX_RETRY_ATTEMPTS; attempt += 1) {
    const result = await flushMetadataOutbox();
    if (result.flushed > 0 && result.failed === 0) {
      return true;
    }
    if (attempt < METADATA_OUTBOX_RETRY_ATTEMPTS - 1) {
      await yieldEventLoop();
      await new Promise((resolve) =>
        setTimeout(resolve, METADATA_OUTBOX_RETRY_DELAY_MS),
      );
    }
  }
  return false;
}

function readNamespaceDatabasesRegistry(
  paprDir: string,
): DatabasesRegistryFile | null {
  const registryPath = path.join(paprDir, "data", DATABASES_REGISTRY_FILENAME);
  if (!fs.existsSync(registryPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      fs.readFileSync(registryPath, "utf8"),
    ) as DatabasesRegistryFile;
    if (parsed?.databases && typeof parsed.databases === "object") {
      return parsed;
    }
  } catch {
    /* invalid on disk */
  }
  return null;
}

/**
 * Upload app db-config + namespace databases registry to Memory Mongo.
 * Throws on failure so Upload/publish does not succeed with stale runtime metadata.
 */
export async function syncMetadataToCloudForFlush(
  paprDir: string,
  appId: string,
  commitSha?: string,
): Promise<void> {
  const updatedAt = new Date().toISOString();
  const errors: string[] = [];
  const configPath = path.join(paprDir, "apps", appId, "data-sources.json");
  const registry = readNamespaceDatabasesRegistry(paprDir);

  const appUploaded = await uploadAppDbConfigToCloud(
    paprDir,
    appId,
    commitSha,
    { timeoutMs: METADATA_FLUSH_TIMEOUT_MS },
  );
  if (appUploaded === false && fs.existsSync(configPath)) {
    errors.push(`app db-config upload failed for ${appId}`);
  }

  let registryUploaded = true;
  if (registry) {
    registryUploaded = await uploadDatabasesRegistryToCloud(registry, updatedAt, {
      timeoutMs: METADATA_FLUSH_TIMEOUT_MS,
    });
    if (!registryUploaded) {
      errors.push("namespace databases registry upload failed");
    }
  }

  if (errors.length > 0) {
    const recoveredViaOutbox = await retryQueuedMetadataUploads();
    if (recoveredViaOutbox) {
      return;
    }

    errors.length = 0;
    if (fs.existsSync(configPath)) {
      const appRetryOk = await uploadAppDbConfigToCloud(
        paprDir,
        appId,
        commitSha,
        { timeoutMs: METADATA_FLUSH_TIMEOUT_MS },
      );
      if (!appRetryOk) {
        errors.push(`app db-config upload failed for ${appId}`);
      }
    }
    if (registry) {
      const registryRetryOk = await uploadDatabasesRegistryToCloud(
        registry,
        updatedAt,
        { timeoutMs: METADATA_FLUSH_TIMEOUT_MS },
      );
      if (!registryRetryOk) {
        errors.push("namespace databases registry upload failed");
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Metadata sync to cloud failed — ${errors.join("; ")}. ` +
        "Web runtime may reject db-token until metadata outbox retries succeed.",
    );
  }
}
