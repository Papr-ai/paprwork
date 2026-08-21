/**
 * Ship schema migration entries to workspace log (memory applies to Turso).
 */

import type { TursoLinkedSource } from "../tursoLinkedSources.js";
import { resolveMigrationRootFromDbPath } from "../jobs/databaseMigrations.js";
import { appendWorkspaceLogEntry, appendWorkspaceLogEntryWithApiKey } from "./WorkspaceLogClient.js";
import { buildSchemaMigrationPayload } from "./buildSchemaMigrationPayload.js";
import { resolveReplicaIdForLinkedSource } from "./workspaceLogSync.js";
import { isSyncV3SchemaLogEnabled } from "./syncV3Flags.js";
import { incrementSyncV3Metric } from "./syncV3Metrics.js";

export async function shipSchemaMigrationLogEntry(
  linked: TursoLinkedSource,
  migrationRoot: string,
  migrationId: string,
  apiKey?: string,
): Promise<boolean> {
  if (!isSyncV3SchemaLogEnabled()) {
    return false;
  }
  const replicaId = resolveReplicaIdForLinkedSource(linked);
  if (!replicaId || !linked.appId) {
    return false;
  }

  const payload = await buildSchemaMigrationPayload(
    migrationRoot,
    migrationId,
    linked.appId,
    linked.alias ?? linked.jobId ?? linked.dbId ?? "primary",
  );
  if (!payload.ops?.length && !payload.statements?.length) {
    console.warn(
      `[SchemaMigration] Skipping ${migrationId} for ${linked.appId}: migration ledger entry has no ops or SQL on disk`,
    );
    return false;
  }

  const request = {
    replicaId,
    kind: "schema" as const,
    dbSourceId: linked.alias ?? linked.jobId ?? linked.dbId,
    payload,
  };
  if (apiKey?.trim()) {
    await appendWorkspaceLogEntryWithApiKey(request, apiKey.trim());
  } else {
    await appendWorkspaceLogEntry(request);
  }
  incrementSyncV3Metric("v3_op_count");
  return true;
}

/** Ship drift-heal payload (synthetic migration id, ops-only). */
export async function shipSchemaDriftHealPayload(
  linked: TursoLinkedSource,
  migrationId: string,
  contentHash: string,
  ops: NonNullable<
    import("../../../core/types/workspaceLog.js").WorkspaceLogSchemaPayload["ops"]
  >,
): Promise<boolean> {
  if (!isSyncV3SchemaLogEnabled()) {
    return false;
  }
  const replicaId = resolveReplicaIdForLinkedSource(linked);
  if (!replicaId || !linked.appId) {
    return false;
  }

  await appendWorkspaceLogEntry({
    replicaId,
    kind: "schema",
    dbSourceId: linked.alias ?? linked.jobId ?? linked.dbId,
    payload: {
      appId: linked.appId,
      dbSlug: linked.alias ?? linked.jobId ?? linked.dbId ?? "primary",
      migrationId,
      contentHash,
      ops,
    },
  });
  incrementSyncV3Metric("v3_op_count");
  return true;
}

export async function shipSchemaMigrationForDbPath(
  linked: TursoLinkedSource,
  dbPath: string,
  migrationIds: readonly string[],
  apiKey?: string,
): Promise<number> {
  const migrationRoot = resolveMigrationRootFromDbPath(dbPath);
  if (!migrationRoot || migrationIds.length === 0) {
    return 0;
  }
  let shipped = 0;
  for (const migrationId of migrationIds) {
    const ok = await shipSchemaMigrationLogEntry(
      linked,
      migrationRoot,
      migrationId,
      apiKey,
    );
    if (ok) {
      shipped += 1;
    }
  }
  return shipped;
}
