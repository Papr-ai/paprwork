/**
 * Shared replica repair helpers — honest pull results, reseed escalation.
 */

import type { AppDataSource } from "../appDataSources.js";
import {
  getDatabaseRegistryService,
  type DatabaseRecord,
} from "../DatabaseRegistryService.js";
import {
  hasBootstrapPendingMarker,
  readBootstrapPendingMarker,
} from "./tursoReplicaBootstrapMarker.js";
import { isReplicaCheckpointWalError } from "./tursoReplicaCheckpointRecovery.js";
import { pullLinkedDbViaTursoReplica } from "./tursoReplicaRouting.js";
import { getTursoReplicaService } from "./TursoReplicaService.js";
import { isTursoReplicaOnline } from "../../utils/tursoReplicaEnabled.js";
import { shouldUseTursoReplicaForDb } from "../../utils/tursoReplicaEnabled.js";

/** After this many failed bootstrap attempts, escalate to full reseed. */
export const MAX_BOOTSTRAP_ATTEMPTS_BEFORE_RESEED = 3;

export function isBootstrapStillPending(dbPath: string): boolean {
  return hasBootstrapPendingMarker(dbPath);
}

export function shouldEscalateBootstrapToReseed(dbPath: string): boolean {
  const marker = readBootstrapPendingMarker(dbPath);
  if (!marker) {
    return false;
  }
  return marker.attempts >= MAX_BOOTSTRAP_ATTEMPTS_BEFORE_RESEED;
}

export async function reseedReplicaRecord(record: DatabaseRecord): Promise<void> {
  const { reseedTursoReplicaFromRemote } = await import("./tursoReplicaProvision.js");
  await reseedTursoReplicaFromRemote(record);
}

/**
 * Pull with optional sidecar repair. Returns true only when pull succeeded and
 * no bootstrap-pending marker remains.
 */
export async function pullReplicaHonest(
  source: AppDataSource,
  options?: {
    forceReconnect?: boolean;
    repairSidecarsIfWedged?: boolean;
    allowReseed?: boolean;
  },
): Promise<{ pulled: boolean; reseeded: boolean; bootstrapPending: boolean }> {
  const dbPath = source.dbPath;
  const dbId = source.dbId ?? source.id;
  const registry = getDatabaseRegistryService();
  const record = dbId ? registry.getById(dbId) : undefined;

  if (options?.repairSidecarsIfWedged) {
    const replica = getTursoReplicaService();
    await replica.close(dbPath);
    const { repairReplicaSidecarWedge } = await import("./tursoReplicaSidecarWedge.js");
    repairReplicaSidecarWedge(dbPath);
  }

  if (
    options?.allowReseed !== false &&
    record &&
    shouldUseTursoReplicaForDb({ syncMode: record.syncMode }) &&
    shouldEscalateBootstrapToReseed(dbPath)
  ) {
    await reseedReplicaRecord(record);
    return {
      pulled: true,
      reseeded: true,
      bootstrapPending: isBootstrapStillPending(dbPath),
    };
  }

  let pulled = false;
  if (isTursoReplicaOnline()) {
    try {
      pulled = await pullLinkedDbViaTursoReplica(source, {
        forceReconnect: options?.forceReconnect ?? false,
      });
    } catch (error) {
      const message = (error as Error).message;
      if (
        options?.allowReseed !== false &&
        record &&
        shouldUseTursoReplicaForDb({ syncMode: record.syncMode }) &&
        isReplicaCheckpointWalError(message)
      ) {
        await reseedReplicaRecord(record);
        return {
          pulled: true,
          reseeded: true,
          bootstrapPending: isBootstrapStillPending(dbPath),
        };
      }
      throw error;
    }
  }

  const bootstrapPending = isBootstrapStillPending(dbPath);
  return {
    pulled: pulled && !bootstrapPending,
    reseeded: false,
    bootstrapPending,
  };
}
