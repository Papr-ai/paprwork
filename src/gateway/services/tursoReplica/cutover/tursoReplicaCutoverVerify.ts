/**
 * Post-cutover health gate — do not mark syncMode=replica until pull + read succeed.
 */

import type { DatabaseRecord } from "../../DatabaseRegistryService.js";
import type { AppDataSource } from "../../appDataSources.js";
import { queryLinkedDbViaTursoReplica } from "../tursoReplicaRouting.js";
import { isTursoReplicaOnline } from "../../../utils/tursoReplicaEnabled.js";

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

export interface ReplicaCutoverVerifyResult {
  ok: boolean;
  error?: string;
}

/** Verify replica can pull and serve a read after cutover provisioning. */
export async function verifyReplicaCutoverHealth(
  record: DatabaseRecord,
): Promise<ReplicaCutoverVerifyResult> {
  if (!record.localPath?.trim()) {
    return { ok: false, error: "Local database path missing after cutover" };
  }

  const source = recordAsDataSource(record);

  try {
    if (isTursoReplicaOnline()) {
      await queryLinkedDbViaTursoReplica(source, "SELECT 1 AS ok", [], {
        pullBeforeRead: true,
      });
    } else {
      await queryLinkedDbViaTursoReplica(source, "SELECT 1 AS ok", [], {
        pullBeforeRead: false,
      });
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: (error as Error).message.slice(0, 500),
    };
  }
}
