/**
 * Plan A Phase 2 — drop provisional local migration ledger rows after cloud-ahead conflict.
 */

import type { AppDataSource } from "../appDataSources.js";
import { writeLinkedDbViaTursoReplica } from "./tursoReplicaRouting.js";

/** Remove cloud-ahead migration ids from local schema_migrations (post-pull rebase). */
export async function rebaseLocalMigrationLedger(
  source: AppDataSource,
  migrationIds: readonly string[],
): Promise<string[]> {
  const removed: string[] = [];
  for (const id of migrationIds) {
    if (!id.trim()) {
      continue;
    }
    const result = await writeLinkedDbViaTursoReplica(
      source,
      "DELETE FROM schema_migrations WHERE id = ?",
      [id],
    );
    if (result.changes > 0) {
      removed.push(id);
    }
  }
  return removed;
}
