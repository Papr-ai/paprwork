/**
 * Ordered replica readiness: drift-heal → schema log → row log.
 * Used by flushAppNow and TursoSyncBridge push paths.
 */

import type { TursoLinkedSource } from "../tursoLinkedSources.js";
import { runSchemaDriftHeal } from "./schemaDriftHeal.js";
import { shipLinkedSourceToWorkspaceLog } from "./workspaceLogSync.js";
import { isSyncV3SchemaLogEnabled } from "./syncV3Flags.js";

export interface EnsureReplicaReadyResult {
  schemaShipped: number;
  rowsShipped: number;
  lastSyncLogId: number;
}

export async function ensureReplicaReady(
  linked: TursoLinkedSource,
  options?: import("./workspaceLogSync.js").WorkspaceLogPushOptions,
): Promise<EnsureReplicaReadyResult> {
  const label = linked.alias ?? linked.jobId ?? linked.dbId ?? "unknown";
  console.log(`[EnsureReplicaReady] Starting for ${label}`);

  try {
    let schemaShipped = 0;
    if (isSyncV3SchemaLogEnabled()) {
      schemaShipped = await runSchemaDriftHeal(linked);
      if (schemaShipped > 0) {
        console.log(
          `[EnsureReplicaReady] Shipped ${schemaShipped} schema migration(s) for ${label}`,
        );
      }
    }

    const rowResult = await shipLinkedSourceToWorkspaceLog(linked, options);
    if (rowResult.shipped > 0) {
      console.log(
        `[EnsureReplicaReady] Shipped ${rowResult.shipped} row op(s) for ${label}`,
      );
    }

    console.log(
      `[EnsureReplicaReady] Complete for ${label} (schema=${schemaShipped}, rows=${rowResult.shipped})`,
    );

    return {
      schemaShipped,
      rowsShipped: rowResult.shipped,
      lastSyncLogId: rowResult.lastSyncLogId,
    };
  } catch (error) {
    console.warn(
      `[EnsureReplicaReady] Failed for ${label}: ${(error as Error).message.slice(0, 300)}`,
    );
    throw error;
  }
}
