/**
 * Plan A Phase 2 — drain provisional replica writes after reconnect (pull → push).
 */

import {
  getDatabaseRegistryService,
  initializeDatabaseRegistry,
} from "../DatabaseRegistryService.js";
import {
  isTursoReplicaOnline,
  isTursoReplicaSyncFeatureEnabled,
  shouldUseTursoReplicaForDb,
} from "../../utils/tursoReplicaEnabled.js";
import { pushLinkedDbViaTursoReplica } from "./tursoReplicaRouting.js";
import type { AppDataSource } from "../appDataSources.js";

let drainInFlight: Promise<void> | null = null;

function recordAsDataSource(record: {
  dbId: string;
  localPath: string;
  createdAt: string;
}): AppDataSource {
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

/** Pull-first push for every registry DB on Plan A replica path. */
export async function drainReplicaDbsOnReconnect(): Promise<void> {
  if (!isTursoReplicaSyncFeatureEnabled() || !isTursoReplicaOnline()) {
    return;
  }

  if (drainInFlight) {
    await drainInFlight;
    return;
  }

  drainInFlight = (async () => {
    await initializeDatabaseRegistry();
    const registry = getDatabaseRegistryService();
    const records = registry
      .listActive()
      .filter((r) => shouldUseTursoReplicaForDb({ syncMode: r.syncMode }));

    for (const record of records) {
      const source = recordAsDataSource(record);
      try {
        const result = await pushLinkedDbViaTursoReplica(source);
        if (result.ok) {
          await registry.updateReplicaPushState(record.dbId, {
            lastReplicaPushError: null,
          });
          console.log(
            `[TursoReplica] Reconnect drain OK for ${record.label ?? record.dbId}`,
          );
        } else {
          await registry.updateReplicaPushState(record.dbId, {
            lastReplicaPushError: result.error ?? "Reconnect push failed",
          });
          console.warn(
            `[TursoReplica] Reconnect drain failed for ${record.label ?? record.dbId}: ${result.error ?? "unknown"}`,
          );
        }
      } catch (error) {
        const message = (error as Error).message;
        await registry.updateReplicaPushState(record.dbId, {
          lastReplicaPushError: message,
        });
        console.warn(
          `[TursoReplica] Reconnect drain error for ${record.label ?? record.dbId}: ${message.slice(0, 200)}`,
        );
      }
    }
  })().finally(() => {
    drainInFlight = null;
  });

  await drainInFlight;
}
