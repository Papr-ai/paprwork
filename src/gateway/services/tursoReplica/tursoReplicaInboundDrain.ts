/**
 * After inbound pull, reconcile phantom CDC counters via pull-only.
 * Never push+checkpoint on replica files — that wedges empty-WAL sidecars.
 */

import type { AppDataSource } from "../appDataSources.js";
import { isTursoReplicaOnline } from "../../utils/tursoReplicaEnabled.js";
import { getTursoReplicaService } from "./TursoReplicaService.js";
import {
  hasLocalOnlyMigrationIds,
  listLocalOnlyMigrationIds,
  readLocalReplicaMigrationIds,
  readRemoteTursoMigrationIds,
} from "./tursoReplicaMigrationConflict.js";
import {
  detectReplicaSidecarWedge,
} from "./tursoReplicaSidecarWedge.js";
import { removeTursoReplicaSidecarsOnly } from "./tursoReplicaFileGuard.js";

export type InboundDrainSkipReason =
  | "offline"
  | "local_only_migrations"
  | "no_cdc"
  | "push_failed";

export interface InboundReplicaDrainResult {
  drained: boolean;
  skippedReason?: InboundDrainSkipReason;
  localOnlyMigrationIds?: string[];
  cdcOperationsBefore?: number;
  cdcOperationsAfter?: number;
  pushError?: string;
}

/** Pull-only reconcile when schema ledger shows inbound-only catch-up. */
export async function drainInboundReplicaCdcIfCaughtUp(options: {
  source: AppDataSource;
  tursoDatabase: string;
}): Promise<InboundReplicaDrainResult> {
  if (!isTursoReplicaOnline()) {
    return { drained: false, skippedReason: "offline" };
  }

  const [localIds, remoteIds] = await Promise.all([
    readLocalReplicaMigrationIds(options.source),
    readRemoteTursoMigrationIds(options.tursoDatabase),
  ]);

  if (hasLocalOnlyMigrationIds(localIds, remoteIds)) {
    return {
      drained: false,
      skippedReason: "local_only_migrations",
      localOnlyMigrationIds: listLocalOnlyMigrationIds(localIds, remoteIds),
    };
  }

  const replica = getTursoReplicaService();
  const cdcBefore = await replica.readCdcOperations(
    options.source.dbPath,
    options.tursoDatabase,
  );
  if (cdcBefore <= 0) {
    return {
      drained: false,
      skippedReason: "no_cdc",
      cdcOperationsBefore: 0,
      cdcOperationsAfter: 0,
    };
  }

  if (detectReplicaSidecarWedge(options.source.dbPath)) {
    await replica.close(options.source.dbPath);
    removeTursoReplicaSidecarsOnly(options.source.dbPath);
  }

  try {
    await replica.pull(options.source.dbPath, options.tursoDatabase);
  } catch (error) {
    return {
      drained: false,
      skippedReason: "push_failed",
      pushError: (error as Error).message,
      cdcOperationsBefore: cdcBefore,
      cdcOperationsAfter: cdcBefore,
    };
  }

  const cdcAfter = await replica.readCdcOperations(
    options.source.dbPath,
    options.tursoDatabase,
  );

  return {
    drained: cdcAfter < cdcBefore,
    cdcOperationsBefore: cdcBefore,
    cdcOperationsAfter: cdcAfter,
  };
}
