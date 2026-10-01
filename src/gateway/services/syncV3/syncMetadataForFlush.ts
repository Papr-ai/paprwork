/**
 * Push namespace databases.json + per-app db config to Mongo after app writer flush.
 * Local disk + per-app git remain source of truth; Mongo is a best-effort runtime mirror
 * retried via metadata outbox + heartbeat (same as DatabaseRegistryService.save).
 */

import * as fs from "fs";
import * as path from "path";
import type { DatabasesRegistryFile } from "../DatabaseRegistryService.js";
import { DATABASES_REGISTRY_FILENAME } from "../DatabaseRegistryService.js";
import { uploadAppDbConfigToCloud } from "./appDbConfigUpload.js";
import { syncDatabasesRegistryToCloudCoalesced } from "./databasesRegistryCloudSync.js";
import { flushMetadataOutbox } from "./metadataOutbox.js";
import { registryUploadErrorDetail } from "./registryUploadDiagnostics.js";
import { yieldEventLoop } from "../cloudSync/yieldEventLoop.js";

const METADATA_FLUSH_TIMEOUT_MS = 60_000;
const METADATA_OUTBOX_RETRY_ATTEMPTS = 3;
const METADATA_OUTBOX_RETRY_DELAY_MS = 2_000;

export interface MetadataFlushSyncResult {
  warnings: string[];
  appDbConfigUploaded: boolean;
  databasesRegistryUploaded: boolean;
  databasesRegistrySkippedDuplicate: boolean;
  metadataOutboxRecovered: boolean;
}

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
 * Best-effort metadata dual-write after publish. Never throws — app code upload must not
 * fail because Memory Mongo hiccuped; outbox + heartbeat drain pending snapshots.
 */
export async function syncMetadataToCloudForFlush(
  paprDir: string,
  appId: string,
  commitSha?: string,
): Promise<MetadataFlushSyncResult> {
  const warnings: string[] = [];
  const configPath = path.join(paprDir, "apps", appId, "data-sources.json");
  const registry = readNamespaceDatabasesRegistry(paprDir);

  let appDbConfigUploaded = !fs.existsSync(configPath);
  if (fs.existsSync(configPath)) {
    appDbConfigUploaded = await uploadAppDbConfigToCloud(
      paprDir,
      appId,
      commitSha,
      { timeoutMs: METADATA_FLUSH_TIMEOUT_MS },
    );
    if (!appDbConfigUploaded) {
      warnings.push(`app db-config upload queued for retry (${appId})`);
    }
  }

  let databasesRegistryUploaded = false;
  let databasesRegistrySkippedDuplicate = false;
  if (registry) {
    const registryResult = await syncDatabasesRegistryToCloudCoalesced(
      paprDir,
      registry,
      { timeoutMs: METADATA_FLUSH_TIMEOUT_MS },
    );
    databasesRegistryUploaded = registryResult.uploaded;
    databasesRegistrySkippedDuplicate = registryResult.skippedDuplicate;
    if (registryResult.queuedForRetry) {
      warnings.push(
        `namespace databases registry upload queued for retry${registryUploadErrorDetail()}`,
      );
    }
  } else {
    databasesRegistryUploaded = true;
  }

  let metadataOutboxRecovered = false;
  if (warnings.length > 0) {
    metadataOutboxRecovered = await retryQueuedMetadataUploads();
    if (metadataOutboxRecovered) {
      warnings.length = 0;
      appDbConfigUploaded = true;
      databasesRegistryUploaded = true;
    } else {
      if (fs.existsSync(configPath) && !appDbConfigUploaded) {
        appDbConfigUploaded = await uploadAppDbConfigToCloud(
          paprDir,
          appId,
          commitSha,
          { timeoutMs: METADATA_FLUSH_TIMEOUT_MS },
        );
        if (!appDbConfigUploaded) {
          warnings.push(`app db-config upload still pending (${appId})`);
        }
      }
      if (registry && !databasesRegistryUploaded) {
        const retry = await syncDatabasesRegistryToCloudCoalesced(
          paprDir,
          registry,
          { force: true, timeoutMs: METADATA_FLUSH_TIMEOUT_MS },
        );
        databasesRegistryUploaded = retry.uploaded;
        if (retry.queuedForRetry) {
          warnings.push(
            `namespace databases registry upload still pending (will retry in background)${registryUploadErrorDetail()}`,
          );
        }
      }
    }
  }

  if (warnings.length > 0) {
    console.warn(
      `[MetadataFlush] ${appId}: publish succeeded; runtime metadata still catching up — ${warnings.join("; ")}`,
    );
  }

  return {
    warnings,
    appDbConfigUploaded,
    databasesRegistryUploaded,
    databasesRegistrySkippedDuplicate,
    metadataOutboxRecovered,
  };
}
