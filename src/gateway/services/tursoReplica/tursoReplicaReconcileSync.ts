/**
 * Agent-facing replica sync reconciliation (sidecar wedges, pull align, push errors).
 */

import type { AppDataSource } from "../appDataSources.js";
import { getDatabaseRegistryService } from "../DatabaseRegistryService.js";
import { getTursoReplicaService } from "./TursoReplicaService.js";
import {
  detectReplicaSidecarWedge,
  repairReplicaSidecarWedge,
  repairReplicaSidecarsOnCheckpointError,
} from "./tursoReplicaSidecarWedge.js";
import {
  completeMigrationPairing,
  getMigrationApplyPair,
} from "./migrationApplyPairing.js";
import {
  alignReplicaAfterCloudMigration,
  buildMigrationParityReport,
} from "./tursoReplicaMigrationDualApply.js";
import { pullLinkedDbViaTursoReplica } from "./tursoReplicaRouting.js";
import { isTursoReplicaOnline } from "../../utils/tursoReplicaEnabled.js";
import { syncStatusForLinkedDb } from "./tursoReplicaRouting.js";

export type ReconcileSyncAction =
  | "repair_sidecar_wedge"
  | "pull_and_align"
  | "clear_push_error"
  | "complete_pairing"
  | "full_parity_check";

export interface ReconcileSyncResult {
  action: ReconcileSyncAction;
  dbId: string;
  sidecarWedgeBefore: boolean;
  sidecarRepaired: boolean;
  pulled: boolean;
  pushErrorCleared: boolean;
  pairingCompleted: boolean;
  parity?: Awaited<ReturnType<typeof buildMigrationParityReport>>;
  syncStatus?: Awaited<ReturnType<typeof syncStatusForLinkedDb>>;
}

export async function reconcileReplicaSync(options: {
  source: AppDataSource;
  dbId: string;
  migrationRoot: string;
  action: ReconcileSyncAction;
  applyToken?: string;
  migrationId?: string;
}): Promise<ReconcileSyncResult> {
  const registry = getDatabaseRegistryService();
  const replica = getTursoReplicaService();
  const sidecarWedgeBefore = detectReplicaSidecarWedge(options.source.dbPath);

  const base: ReconcileSyncResult = {
    action: options.action,
    dbId: options.dbId,
    sidecarWedgeBefore,
    sidecarRepaired: false,
    pulled: false,
    pushErrorCleared: false,
    pairingCompleted: false,
  };

  switch (options.action) {
    case "repair_sidecar_wedge": {
      await replica.close(options.source.dbPath);
      const repaired =
        repairReplicaSidecarWedge(options.source.dbPath) ||
        repairReplicaSidecarsOnCheckpointError(options.source.dbPath);
      let pulled = false;
      if (isTursoReplicaOnline()) {
        pulled = await pullLinkedDbViaTursoReplica(options.source, {
          forceReconnect: true,
        });
      }
      await registry.updateReplicaPushState(options.dbId, {
        lastReplicaPushError: null,
      });
      return {
        ...base,
        sidecarRepaired: repaired,
        pulled,
        pushErrorCleared: true,
        syncStatus: await syncStatusForLinkedDb(options.source),
      };
    }
    case "pull_and_align": {
      await replica.close(options.source.dbPath);
      if (sidecarWedgeBefore) {
        repairReplicaSidecarWedge(options.source.dbPath);
      }
      const { pulled } = await alignReplicaAfterCloudMigration(options.source);
      return {
        ...base,
        sidecarRepaired: sidecarWedgeBefore,
        pulled,
        syncStatus: await syncStatusForLinkedDb(options.source),
      };
    }
    case "clear_push_error": {
      await registry.updateReplicaPushState(options.dbId, {
        lastReplicaPushError: null,
        cutoverBlocked: false,
        cutoverBlockReason: null,
      });
      return {
        ...base,
        pushErrorCleared: true,
        syncStatus: await syncStatusForLinkedDb(options.source),
      };
    }
    case "complete_pairing": {
      if (!options.applyToken?.trim() || !options.migrationId?.trim()) {
        throw new Error(
          "complete_pairing requires migrationId and applyToken from replica/cloud apply.",
        );
      }
      await completeMigrationPairing({
        migrationRoot: options.migrationRoot,
        migrationId: options.migrationId,
        applyToken: options.applyToken,
      });
      const pair = await getMigrationApplyPair(
        options.migrationRoot,
        options.migrationId,
      );
      let pulled = false;
      if (pair?.pairedAt && isTursoReplicaOnline()) {
        const align = await alignReplicaAfterCloudMigration(options.source);
        pulled = align.pulled;
      }
      await registry.updateReplicaPushState(options.dbId, {
        lastReplicaPushError: null,
      });
      return {
        ...base,
        pairingCompleted: true,
        pulled,
        pushErrorCleared: true,
        syncStatus: await syncStatusForLinkedDb(options.source),
      };
    }
    case "full_parity_check": {
      const parity = await buildMigrationParityReport({
        source: options.source,
        migrationRoot: options.migrationRoot,
        dbId: options.dbId,
      });
      return {
        ...base,
        parity,
        syncStatus: await syncStatusForLinkedDb(options.source),
      };
    }
    default: {
      const exhaustive: never = options.action;
      throw new Error(`Unknown reconcile action: ${String(exhaustive)}`);
    }
  }
}
