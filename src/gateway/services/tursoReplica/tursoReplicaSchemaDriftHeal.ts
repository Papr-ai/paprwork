/**
 * Heal Turso Sync replica handle when schema_migrations says applied but tables
 * are missing (ledger drift vs embedded handle).
 */

import type { AppDataSource } from "../appDataSources.js";
import { isHomeDailyBriefRegistryDbPath } from "../defaultHomeBundle.js";
import { resolvePersistedDatabaseLayout } from "../jobs/databaseMigrations.js";
import { isReplicaManagedDbPath } from "./tursoReplicaFileGuard.js";

export function isReplicaMissingTableError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("no such table:") ||
    (lower.includes("parse error:") && lower.includes("no such table"))
  );
}

/** One-shot heal: apply missing registry migrations on the replica handle, then close it. */
export async function healReplicaSchemaDrift(source: AppDataSource): Promise<boolean> {
  const dbPath = source.dbPath?.trim();
  if (!dbPath || !isReplicaManagedDbPath(dbPath)) {
    return false;
  }

  if (isHomeDailyBriefRegistryDbPath(dbPath)) {
    const { ensureHomeDailyBriefRegistrySchema } = await import(
      "../defaultHomeAppRepair.js"
    );
    await ensureHomeDailyBriefRegistrySchema(dbPath);
    return true;
  }

  const layout = resolvePersistedDatabaseLayout(dbPath);
  if (!layout || layout.kind !== "registry") {
    return false;
  }

  const { applyRegistryDatabaseMigrations } = await import(
    "../jobs/databaseMigrations.js"
  );
  await applyRegistryDatabaseMigrations(dbPath);

  const { getTursoReplicaSyncWorkerClient } = await import(
    "./TursoReplicaSyncWorkerClient.js"
  );
  await getTursoReplicaSyncWorkerClient().close(dbPath).catch(() => undefined);
  return true;
}
