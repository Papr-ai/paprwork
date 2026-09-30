/**
 * Build workspace log schema payloads from local migration files/manifest.
 */

import type { WorkspaceLogSchemaPayload } from "../../../core/types/workspaceLog.js";
import {
  loadJobMigrationManifest,
  manifestEntryById,
  readMigrationSql,
} from "../jobs/jobMigrationManifest.js";
import { computeSchemaPayloadContentHash } from "../jobs/migrationContentHash.js";
import { normalizeMigrationId } from "../jobs/migrationIdNormalize.js";
import { splitSqlStatements } from "../jobs/migrationSqlHelpers.js";

export async function buildSchemaMigrationPayload(
  migrationRoot: string,
  migrationId: string,
  appId: string,
  dbSlug: string,
): Promise<WorkspaceLogSchemaPayload> {
  const normalizedId = normalizeMigrationId(migrationId);
  const manifest = await loadJobMigrationManifest(migrationRoot);
  const entry =
    manifestEntryById(manifest, migrationId) ??
    manifestEntryById(manifest, normalizedId) ??
    manifestEntryById(manifest, `${normalizedId}.sql`);

  const ops = entry?.ops?.length ? entry.ops : undefined;
  const sql =
    (await readMigrationSql(migrationRoot, migrationId)) ??
    (await readMigrationSql(migrationRoot, `${normalizedId}.sql`));
  const statements =
    sql && !ops?.length ? splitSqlStatements(sql) : undefined;

  const payload: WorkspaceLogSchemaPayload = {
    appId,
    dbSlug,
    migrationId: normalizedId,
    contentHash: "",
  };
  if (ops?.length) {
    payload.ops = ops;
  } else if (statements?.length) {
    payload.statements = statements;
  }

  payload.contentHash = computeSchemaPayloadContentHash({
    migrationId: normalizedId,
    ops: payload.ops ?? null,
    statements: payload.statements ?? null,
  });
  return payload;
}
