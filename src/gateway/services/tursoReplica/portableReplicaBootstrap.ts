/**
 * Re-bind Turso Sync replicas after portable app transfers (cross-namespace copy,
 * community/team install). Copied SQLite keeps source-namespace sidecars until
 * reset; the target namespace Turso DB is empty and must be seeded on first use.
 */

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import path from "path";
import type {
  BootstrapPendingReason,
  BootstrapPendingMarker,
} from "./tursoReplicaBootstrapMarker.js";
import {
  hasBootstrapPendingMarker,
  readBootstrapPendingMarker,
  writeBootstrapPendingMarker,
} from "./tursoReplicaBootstrapMarker.js";
import { removeTursoReplicaSidecarsOnly } from "./tursoReplicaFileGuard.js";
import type {
  DatabaseRecord,
  DatabasesRegistryFile,
} from "../DatabaseRegistryService.js";
import { resolveReadableRegistryDbPath } from "../resolveRegistryDbPath.js";
import { clearLegacyTursoSyncStateForDbPath } from "../tursoSyncState.js";
import {
  isTursoReplicaOnline,
  isTursoReplicaSyncFeatureEnabled,
  shouldUseTursoReplicaForDb,
} from "../../utils/tursoReplicaEnabled.js";
import type { AppDataSource } from "../appDataSources.js";

export type PortableReplicaTransferReason = Extract<
  BootstrapPendingReason,
  "cross_namespace_copy" | "portable_install" | "team_collaborate_attach"
>;

export const PORTABLE_REPLICA_TRANSFER_REASONS: readonly PortableReplicaTransferReason[] =
  ["cross_namespace_copy", "portable_install", "team_collaborate_attach"];

function recordAsDataSource(record: DatabaseRecord): AppDataSource {
  return {
    id: record.dbId,
    type: "sqlite",
    alias: record.dbId,
    dbId: record.dbId,
    dbPath: record.localPath,
    tables: [],
    linkedAt: record.createdAt,
  };
}

async function readRegistryFromPaprHome(
  paprHome: string,
): Promise<DatabasesRegistryFile> {
  const registryPath = path.join(paprHome, "data", "databases.json");
  try {
    const raw = await readFile(registryPath, "utf8");
    return JSON.parse(raw) as DatabasesRegistryFile;
  } catch {
    return { version: 1, databases: {} };
  }
}

/** Strip stale sync sidecars and mark for bootstrap-before-open (marker first). */
export function prepareReplicaForPortableTransfer(
  dbPath: string,
  reason: PortableReplicaTransferReason,
  paprHome?: string,
): boolean {
  if (!isTursoReplicaSyncFeatureEnabled()) {
    return false;
  }
  if (!existsSync(dbPath)) {
    return false;
  }

  writeBootstrapPendingMarker(dbPath, reason);
  removeTursoReplicaSidecarsOnly(dbPath);
  if (paprHome) {
    clearLegacyTursoSyncStateForDbPath(dbPath, paprHome);
  }
  return true;
}

export interface PreparePortableReplicaDatabasesInput {
  paprHome: string;
  registryDbIds: readonly string[];
  copiedJobIds?: readonly string[];
  reason: PortableReplicaTransferReason;
}

export function portableReplicaReasonForInstallPolicy(
  installDbPolicy?: import("../cloudInstallDbPolicy.js").InstallDbPolicy,
): PortableReplicaTransferReason {
  if (installDbPolicy === "shared_primary") {
    return "team_collaborate_attach";
  }
  return "portable_install";
}

export interface PreparePortableReplicaDatabasesResult {
  preparedDbIds: string[];
}

/**
 * File-level prep for copied registry DBs — safe while the user is still in the
 * source workspace (no Turso API calls; uses target paprHome paths only).
 */
export async function preparePortableReplicaDatabases(
  input: PreparePortableReplicaDatabasesInput,
): Promise<PreparePortableReplicaDatabasesResult> {
  if (!isTursoReplicaSyncFeatureEnabled()) {
    return { preparedDbIds: [] };
  }

  const registry = await readRegistryFromPaprHome(input.paprHome);
  const dataDir = path.join(input.paprHome, "data");
  const jobIdSet = new Set(input.copiedJobIds ?? []);
  const dbIdsToProcess = new Set(input.registryDbIds);

  for (const [dbId, record] of Object.entries(registry.databases)) {
    if (record.ownerJobId && jobIdSet.has(record.ownerJobId)) {
      dbIdsToProcess.add(dbId);
    }
  }

  const preparedDbIds: string[] = [];

  for (const dbId of dbIdsToProcess) {
    const record = registry.databases[dbId];
    if (!record || !shouldUseTursoReplicaForDb({ syncMode: record.syncMode })) {
      continue;
    }

    const localPath = resolveReadableRegistryDbPath({
      dbPath: record.localPath,
      dataDir,
    });
    if (!localPath) {
      continue;
    }

    if (prepareReplicaForPortableTransfer(localPath, input.reason, input.paprHome)) {
      preparedDbIds.push(dbId);
      console.log(
        `[PortableReplica] Prepared ${dbId} for ${input.reason} at ${localPath}`,
      );
    }
  }

  return { preparedDbIds };
}

function isPortableTransferMarker(
  marker: BootstrapPendingMarker | null,
): marker is BootstrapPendingMarker & { reason: PortableReplicaTransferReason } {
  if (!marker) {
    return false;
  }
  return (PORTABLE_REPLICA_TRANSFER_REASONS as readonly string[]).includes(
    marker.reason,
  );
}

export interface RebootstrapPortableReplicasResult {
  attempted: number;
  succeeded: number;
  failed: Array<{ dbId: string; error: string }>;
}

/**
 * Push local copied rows to the active workspace Turso DB, then reseed the replica.
 * Call after workspace switch or community install when Turso credentials match paprHome.
 */
export async function rebootstrapPendingPortableReplicas(): Promise<RebootstrapPortableReplicasResult> {
  const result: RebootstrapPortableReplicasResult = {
    attempted: 0,
    succeeded: 0,
    failed: [],
  };

  // Cloud-direct copies (devices with no sync engine) are finished here too,
  // so the replica-feature gate applies to replica records only.
  if (!isTursoReplicaOnline()) {
    return result;
  }
  const replicaEnabled = isTursoReplicaSyncFeatureEnabled();

  const { getDatabaseRegistryService } = await import(
    "../DatabaseRegistryService.js"
  );
  const registry = getDatabaseRegistryService();

  for (const record of registry.listActive()) {
    if (record.syncMode === "cloud-direct") {
      const outcome = await finishCloudDirectCopy(record);
      if (outcome !== "skipped") {
        result.attempted += 1;
        if (outcome === "ok") {
          result.succeeded += 1;
        } else {
          result.failed.push({ dbId: record.dbId, error: outcome.error });
        }
      }
      continue;
    }
    if (!replicaEnabled || !shouldUseTursoReplicaForDb({ syncMode: record.syncMode })) {
      continue;
    }
    if (!hasBootstrapPendingMarker(record.localPath)) {
      continue;
    }

    const marker = readBootstrapPendingMarker(record.localPath);
    if (!isPortableTransferMarker(marker)) {
      continue;
    }
    result.attempted += 1;

    try {
      if (marker.reason === "team_collaborate_attach") {
        const { reseedTursoReplicaFromRemote } = await import(
          "./tursoReplicaProvision.js"
        );
        await reseedTursoReplicaFromRemote(record);
        result.succeeded += 1;
        console.log(
          `[PortableReplica] Pulled publisher primary for ${record.dbId} (${marker.reason})`,
        );
        continue;
      }

      const { pushReplicaBootstrapAndReseedVerified } = await import(
        "./tursoReplicaProvision.js"
      );
      const source = recordAsDataSource(record);
      const push = await pushReplicaBootstrapAndReseedVerified(record, source);
      if (!push.ok) {
        result.failed.push({
          dbId: record.dbId,
          error: push.error ?? "Bootstrap push failed",
        });
        continue;
      }

      result.succeeded += 1;
      console.log(
        `[PortableReplica] Rebootstrapped ${record.dbId} after ${marker.reason}`,
      );
    } catch (error) {
      result.failed.push({
        dbId: record.dbId,
        error: (error as Error).message,
      });
    }
  }

  return result;
}

/**
 * Cloud-direct database copied from another workspace: the copy left a
 * schema-only local file + marker because the target workspace's cloud was
 * not reachable yet. Build the primary from the migrations (atomic, snapshot
 * aware), then drop the local file — cloud-direct keeps no local copy.
 */
async function finishCloudDirectCopy(
  record: DatabaseRecord,
): Promise<"skipped" | "ok" | { error: string }> {
  const marker = readBootstrapPendingMarker(record.localPath);
  if (!isPortableTransferMarker(marker)) {
    return "skipped";
  }
  try {
    const { applyCloudDirectMigrations } = await import(
      "../cloudDirect/cloudDirectMigrations.js"
    );
    await applyCloudDirectMigrations(path.dirname(record.localPath), record.localPath);
    const { removeTursoReplicaLocalFiles } = await import("./tursoReplicaFileGuard.js");
    removeTursoReplicaLocalFiles(record.localPath);
    console.log(`[PortableReplica] Built cloud-direct primary for ${record.dbId}`);
    return "ok";
  } catch (error) {
    // Marker stays: retried on the next switch/startup.
    return { error: (error as Error).message };
  }
}
