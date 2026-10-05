/**
 * Single path for uploading namespace databases.json to Memory Mongo.
 * Coalesces duplicate snapshots (save + every publish flush) to avoid rate limits.
 */

import { sanitizeDatabasesRegistryForCloudExport } from "../databaseRegistryTombstonePolicy.js";
import type { DatabasesRegistryFile } from "../DatabaseRegistryService.js";
import { fileContentHash } from "../../utils/fileContentHash.js";
import { uploadDatabasesRegistryToCloud } from "./MetadataRegistryClient.js";

/** Skip identical registry PUTs within this window (back-to-back app publishes). */
const COALESCE_WINDOW_MS = 120_000;

/** After a failed PUT, publishes skip identical snapshots for this long (outbox retries). */
const FAILURE_BACKOFF_MS = 60_000;

const lastFailedUpload = new Map<string, { contentHash: string; atMs: number }>();
const inflightUploads = new Map<string, Promise<boolean>>();

const lastSuccessfulUpload = new Map<
  string,
  { contentHash: string; atMs: number }
>();

function registryContentHash(
  registry: DatabasesRegistryFile,
  paprDir: string,
): string {
  const { registry: sanitized } = sanitizeDatabasesRegistryForCloudExport(
    registry,
    paprDir,
  );
  return fileContentHash(JSON.stringify(sanitized));
}

export interface DatabasesRegistryCloudSyncResult {
  uploaded: boolean;
  skippedDuplicate: boolean;
  queuedForRetry: boolean;
}

export async function syncDatabasesRegistryToCloudCoalesced(
  paprDir: string,
  registry: DatabasesRegistryFile,
  options?: { force?: boolean; timeoutMs?: number },
): Promise<DatabasesRegistryCloudSyncResult> {
  const updatedAt = new Date().toISOString();
  const contentHash = registryContentHash(registry, paprDir);
  const last = lastSuccessfulUpload.get(paprDir);
  const now = Date.now();

  if (
    !options?.force &&
    last &&
    last.contentHash === contentHash &&
    now - last.atMs < COALESCE_WINDOW_MS
  ) {
    return { uploaded: true, skippedDuplicate: true, queuedForRetry: false };
  }

  // A recent identical snapshot failed: it is already queued in the outbox.
  const failed = lastFailedUpload.get(paprDir);
  if (
    !options?.force &&
    failed &&
    failed.contentHash === contentHash &&
    now - failed.atMs < FAILURE_BACKOFF_MS
  ) {
    return { uploaded: false, skippedDuplicate: false, queuedForRetry: true };
  }

  // Parallel publishes share one PUT of the same snapshot.
  const key = `${paprDir}\0${contentHash}`;
  let pending = inflightUploads.get(key);
  if (!pending) {
    pending = uploadDatabasesRegistryToCloud(registry, updatedAt, {
      timeoutMs: options?.timeoutMs,
    }).finally(() => inflightUploads.delete(key));
    inflightUploads.set(key, pending);
  }
  const ok = await pending;
  if (ok) {
    lastSuccessfulUpload.set(paprDir, { contentHash, atMs: Date.now() });
    lastFailedUpload.delete(paprDir);
    return { uploaded: true, skippedDuplicate: false, queuedForRetry: false };
  }

  lastFailedUpload.set(paprDir, { contentHash, atMs: Date.now() });
  return { uploaded: false, skippedDuplicate: false, queuedForRetry: true };
}

/** Test-only */
export function resetDatabasesRegistryCloudSyncStateForTests(): void {
  lastSuccessfulUpload.clear();
  lastFailedUpload.clear();
  inflightUploads.clear();
}
