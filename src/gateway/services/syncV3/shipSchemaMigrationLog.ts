/**
 * Ship schema migration entries to workspace log (memory applies to Turso).
 */

import type {
  WorkspaceLogBatchEntry,
  WorkspaceLogSchemaPayload,
} from "../../../core/types/workspaceLog.js";
import type { TursoLinkedSource } from "../tursoLinkedSources.js";
import { resolveMigrationRootFromDbPath } from "../jobs/databaseMigrations.js";
import {
  appendWorkspaceLogBatch,
  appendWorkspaceLogEntry,
  appendWorkspaceLogEntryWithApiKey,
} from "./WorkspaceLogClient.js";
import { buildSchemaMigrationPayload } from "./buildSchemaMigrationPayload.js";
import { resolveReplicaIdForLinkedSource } from "./workspaceLogSync.js";
import { isSyncV3SchemaLogEnabled } from "./syncV3Flags.js";
import { incrementSyncV3Metric } from "./syncV3Metrics.js";

const SCHEMA_DRIFT_HEAL_PREFIX = "__schema_drift_heal__";

function schemaBatchTimeoutMs(entryCount: number): number {
  // Migrations and table rebuilds can take minutes on Turso — allow up to 10 minutes.
  return Math.min(600_000, 120_000 + entryCount * 60_000);
}

function dbSourceIdForLinked(linked: TursoLinkedSource): string | undefined {
  return linked.alias ?? linked.jobId ?? linked.dbId;
}

function replicaContext(linked: TursoLinkedSource): {
  replicaId: string;
  dbSourceId: string | undefined;
} | null {
  const replicaId = resolveReplicaIdForLinkedSource(linked);
  if (!replicaId || !linked.appId) {
    return null;
  }
  return { replicaId, dbSourceId: dbSourceIdForLinked(linked) };
}

function schemaBatchEntry(
  linked: TursoLinkedSource,
  payload: WorkspaceLogSchemaPayload,
): WorkspaceLogBatchEntry {
  return {
    kind: "schema",
    dbSourceId: dbSourceIdForLinked(linked),
    payload,
  };
}

/** Ship many schema log entries in one append-batch (memory applies all before HTTP 200). */
export async function shipSchemaLogBatch(
  linked: TursoLinkedSource,
  entries: readonly WorkspaceLogBatchEntry[],
  apiKey?: string,
): Promise<number> {
  if (!isSyncV3SchemaLogEnabled() || entries.length === 0) {
    return 0;
  }
  const ctx = replicaContext(linked);
  if (!ctx) {
    return 0;
  }

  const timeoutMs = schemaBatchTimeoutMs(entries.length);
  if (apiKey?.trim()) {
    // Maintenance scripts — fall back to sequential single appends when API key is set.
    let shipped = 0;
    for (const entry of entries) {
      if (entry.kind !== "schema") {
        continue;
      }
      await appendWorkspaceLogEntryWithApiKey(
        {
          replicaId: ctx.replicaId,
          kind: "schema",
          dbSourceId: entry.dbSourceId,
          payload: entry.payload,
        },
        apiKey.trim(),
      );
      shipped += 1;
      incrementSyncV3Metric("v3_op_count");
    }
    return shipped;
  }

  await appendWorkspaceLogBatch(
    { replicaId: ctx.replicaId, entries: [...entries] },
    { timeoutMs },
  );
  for (let i = 0; i < entries.length; i += 1) {
    incrementSyncV3Metric("v3_op_count");
  }
  return entries.length;
}

export async function shipSchemaMigrationLogEntry(
  linked: TursoLinkedSource,
  migrationRoot: string,
  migrationId: string,
  apiKey?: string,
): Promise<boolean> {
  if (!isSyncV3SchemaLogEnabled()) {
    return false;
  }
  const ctx = replicaContext(linked);
  if (!ctx) {
    return false;
  }

  const payload = await buildSchemaMigrationPayload(
    migrationRoot,
    migrationId,
    linked.appId!,
    linked.alias ?? linked.jobId ?? linked.dbId ?? "primary",
  );
  if (!payload.ops?.length && !payload.statements?.length) {
    console.warn(
      `[SchemaMigration] Skipping ${migrationId} for ${linked.appId}: migration ledger entry has no ops or SQL on disk`,
    );
    return false;
  }

  const request = {
    replicaId: ctx.replicaId,
    kind: "schema" as const,
    dbSourceId: ctx.dbSourceId,
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
  ops: NonNullable<WorkspaceLogSchemaPayload["ops"]>,
): Promise<boolean> {
  if (!isSyncV3SchemaLogEnabled()) {
    return false;
  }
  const ctx = replicaContext(linked);
  if (!ctx) {
    return false;
  }

  await appendWorkspaceLogEntry({
    replicaId: ctx.replicaId,
    kind: "schema",
    dbSourceId: ctx.dbSourceId,
    payload: {
      appId: linked.appId!,
      dbSlug: linked.alias ?? linked.jobId ?? linked.dbId ?? "primary",
      migrationId,
      contentHash,
      ops,
    },
  });
  incrementSyncV3Metric("v3_op_count");
  return true;
}

export async function buildSchemaMigrationBatchEntries(
  linked: TursoLinkedSource,
  dbPath: string,
  migrationIds: readonly string[],
): Promise<WorkspaceLogBatchEntry[]> {
  const migrationRoot = resolveMigrationRootFromDbPath(dbPath);
  if (!migrationRoot || migrationIds.length === 0 || !linked.appId) {
    return [];
  }

  const entries: WorkspaceLogBatchEntry[] = [];
  for (const migrationId of migrationIds) {
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
      continue;
    }
    entries.push(schemaBatchEntry(linked, payload));
  }
  return entries;
}

/** Ship pending migrations + optional drift-heal ops in one append-batch. */
export async function shipSchemaMigrationBatch(
  linked: TursoLinkedSource,
  dbPath: string,
  migrationIds: readonly string[],
  healOps?: WorkspaceLogSchemaPayload["ops"],
  apiKey?: string,
): Promise<number> {
  const entries = await buildSchemaMigrationBatchEntries(
    linked,
    dbPath,
    migrationIds,
  );

  if (healOps?.length) {
    const migrationId = `${SCHEMA_DRIFT_HEAL_PREFIX}_${Date.now()}`;
    const { computeSchemaPayloadContentHash } = await import(
      "../jobs/migrationContentHash.js"
    );
    const contentHash = computeSchemaPayloadContentHash({
      migrationId,
      ops: healOps,
      statements: null,
    });
    entries.push(
      schemaBatchEntry(linked, {
        appId: linked.appId!,
        dbSlug: linked.alias ?? linked.jobId ?? linked.dbId ?? "primary",
        migrationId,
        contentHash,
        ops: healOps,
      }),
    );
  }

  if (entries.length === 0) {
    return 0;
  }

  return shipSchemaLogBatch(linked, entries, apiKey);
}

export async function shipSchemaMigrationForDbPath(
  linked: TursoLinkedSource,
  dbPath: string,
  migrationIds: readonly string[],
  apiKey?: string,
): Promise<number> {
  return shipSchemaMigrationBatch(linked, dbPath, migrationIds, undefined, apiKey);
}
