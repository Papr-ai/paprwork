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

  const ok = await uploadDatabasesRegistryToCloud(registry, updatedAt, {
    timeoutMs: options?.timeoutMs,
  });
  if (ok) {
    lastSuccessfulUpload.set(paprDir, { contentHash, atMs: now });
    return { uploaded: true, skippedDuplicate: false, queuedForRetry: false };
  }

  return { uploaded: false, skippedDuplicate: false, queuedForRetry: true };
}

/** Test-only */
export function resetDatabasesRegistryCloudSyncStateForTests(): void {
  lastSuccessfulUpload.clear();
}
