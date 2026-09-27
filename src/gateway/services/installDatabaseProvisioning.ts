/**
 * One place that decides how a cloud-installed database is stored on this
 * device, and puts it in that state before any migration runs.
 *
 *   fork / private copy  → a brand-new database: replica where this OS/CPU has
 *                          a Turso Sync engine, cloud-direct where it does not
 *                          (Intel Mac, Windows ARM), plain local only when
 *                          cloud sync is off.
 *   team shared database → the publisher's mode where this device can run it;
 *                          cloud-direct where it cannot (instead of a replica
 *                          record nothing on this device can sync).
 *
 * Before this, forks had their syncMode stripped and were forced onto the
 * legacy better-sqlite3 migration runner (bypassReplicaEngine) — the path the
 * LinkedIn Outreach install broke on.
 */

import { existsSync } from "fs";
import {
  initializeDatabaseRegistry,
  tursoNameForRecord,
  type DatabaseRecord,
} from "./DatabaseRegistryService.js";
import type { InstallDbPolicy } from "./cloudInstallDbPolicy.js";
import type { DatabaseSyncMode } from "./tursoReplica/tursoReplicaTypes.js";
import { syncModeForInstalledDatabase } from "../utils/tursoReplicaEnabled.js";

export interface ProvisionedInstallDatabase {
  dbId: string;
  syncMode: DatabaseSyncMode | undefined;
}

async function removeLocalFiles(localPath: string): Promise<void> {
  if (!existsSync(localPath)) {
    return;
  }
  const { removeTursoReplicaLocalFiles } = await import(
    "./tursoReplica/tursoReplicaFileGuard.js"
  );
  removeTursoReplicaLocalFiles(localPath);
}

const NETWORK_RETRY_DELAYS_MS = [300, 1200];

function isNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return (
    lower.includes("fetch error") ||
    lower.includes("fetch failed") ||
    lower.includes("connect timeout") ||
    lower.includes("und_err_connect_timeout") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("etimedout") ||
    lower.includes("network request failed")
  );
}

/**
 * A brief network blip while creating the cloud database should not fail the
 * whole install. Retries only network errors; anything else fails at once.
 */
async function withNetworkRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delay = NETWORK_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isNetworkError(error)) {
        throw error;
      }
      console.warn(
        `[InstallProvision] Network error setting up cloud database, retrying in ${delay}ms:`,
        (error as Error).message,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function provisionOne(
  record: DatabaseRecord,
  installDbPolicy: InstallDbPolicy,
): Promise<ProvisionedInstallDatabase> {
  const registry = await initializeDatabaseRegistry();
  const syncMode = syncModeForInstalledDatabase({
    installDbPolicy,
    publisherSyncMode: record.syncMode,
  });

  // Job-owned databases keep whatever the job path already set up.
  if (record.ownerJobId) {
    return { dbId: record.dbId, syncMode: record.syncMode };
  }

  const updated = (await registry.assignSyncMode(record.dbId, syncMode)) ?? record;

  if (syncMode === "cloud-direct") {
    // The primary is the only copy. A stray local file would be read by
    // something eventually and disagree with the primary.
    await removeLocalFiles(updated.localPath);
    return { dbId: record.dbId, syncMode };
  }

  if (syncMode === "replica" && installDbPolicy === "fork_empty") {
    const { provisionTursoReplicaForRecord } = await import(
      "./tursoReplica/tursoReplicaProvision.js"
    );
    await withNetworkRetry(() => provisionTursoReplicaForRecord(updated));
  }

  return { dbId: record.dbId, syncMode };
}

/**
 * Assign and provision storage for every registry database an install linked.
 * Throws on the first failure — the caller rolls the whole install back.
 */
export async function provisionInstalledDatabases(input: {
  registryDbIds: readonly string[];
  installDbPolicy: InstallDbPolicy;
}): Promise<ProvisionedInstallDatabase[]> {
  // copyAppToNamespace writes databases.json directly; reload so the
  // singleton does not save a stale cache over the merged records.
  const registry = await initializeDatabaseRegistry();
  const out: ProvisionedInstallDatabase[] = [];
  for (const dbId of input.registryDbIds) {
    const record = registry.getById(dbId);
    if (!record) {
      continue;
    }
    try {
      out.push(await provisionOne(record, input.installDbPolicy));
    } catch (error) {
      console.error(
        `[InstallProvision] Could not set up database ${dbId}:`,
        (error as Error).message,
      );
      if (isNetworkError(error)) {
        throw Object.assign(
          new Error(
            `Couldn't reach Papr cloud to set up the "${record.label ?? dbId}" database. ` +
              "Nothing was installed — check your connection and try again.",
          ),
          { code: "install_network_unavailable", status: 503 },
        );
      }
      throw new Error(
        `Could not set up database "${record.label ?? dbId}": ${(error as Error).message}`,
      );
    }
  }
  return out;
}

/**
 * Clean slate for a fork database before the one install retry: drop the
 * freshly-created cloud database and local files, then provision again.
 * Never used on a team shared database — that data is not ours to drop.
 */
export async function resetForkDatabaseForRetry(dbId: string): Promise<void> {
  const registry = await initializeDatabaseRegistry();
  const record = registry.getById(dbId);
  if (!record || record.ownerJobId) {
    return;
  }
  try {
    const { getTursoSyncBridge } = await import("./TursoSyncBridge.js");
    const bridge = getTursoSyncBridge();
    if (bridge?.enabled && record.syncMode) {
      const { closeCloudDirectClient } = await import(
        "./cloudDirect/cloudDirectDb.js"
      );
      closeCloudDirectClient(tursoNameForRecord(record));
      if (record.syncMode === "replica") {
        const { getTursoReplicaSyncWorkerClient } = await import(
          "./tursoReplica/TursoReplicaSyncWorkerClient.js"
        );
        await getTursoReplicaSyncWorkerClient()
          .close(record.localPath)
          .catch(() => undefined);
      }
      await bridge.deleteTursoDatabaseByName(tursoNameForRecord(record));
    }
  } catch (error) {
    console.warn(
      `[InstallProvision] Could not drop cloud database for ${dbId} before retry:`,
      (error as Error).message,
    );
  }
  await removeLocalFiles(record.localPath);
  await provisionOne(record, "fork_empty");
}
