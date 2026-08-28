/**
 * Drain phantom outbound CDC after inbound pull (cloud HTTP → desktop pull).
 * When migration ledger is caught up (no local-only ids), push+checkpoint clears
 * local WAL counters without re-uploading schema already on Turso primary.
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

/** Push (no pull) + checkpoint when schema ledger shows inbound-only catch-up. */
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

  const pushResult = await replica.push(
    options.source.dbPath,
    options.tursoDatabase,
    { pullBeforePush: false },
  );
  if (!pushResult.ok) {
    return {
      drained: false,
      skippedReason: "push_failed",
      pushError: pushResult.error,
      cdcOperationsBefore: cdcBefore,
      cdcOperationsAfter: cdcBefore,
    };
  }

  await replica.pull(options.source.dbPath, options.tursoDatabase);
  await replica.checkpoint(options.source.dbPath, options.tursoDatabase);
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
