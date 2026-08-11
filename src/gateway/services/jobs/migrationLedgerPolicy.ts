/**
 * Shared rules for migration ledger markers vs real migrations.
 * Sync, verify, and ledger bridge must agree — baseline placeholders are no-ops.
 */

import type { JobMigrationSchemaOp } from "../../../core/types/jobMigrations.js";
import {
  loadJobMigrationManifest,
  manifestEntryById,
  readMigrationSql,
} from "./jobMigrationManifest.js";
import { splitSqlStatements } from "./migrationSqlHelpers.js";

/** Ledger-only ids — never applied to remote or verified as schema ops. */
export const MIGRATION_LEDGER_MARKERS = new Set([
  "0001_baseline",
  "0001_baseline.sql",
]);

export function isMigrationLedgerMarker(migrationId: string): boolean {
  return MIGRATION_LEDGER_MARKERS.has(migrationId);
}

/** Skip when hydrating/reconciling remote or local ledgers. */
export function shouldSkipMigrationForRemoteLedger(migrationId: string): boolean {
  return isMigrationLedgerMarker(migrationId);
}

async function migrationOpsFromRoot(
  migrationRoot: string,
  migrationId: string,
): Promise<JobMigrationSchemaOp[] | null> {
  const manifest = await loadJobMigrationManifest(migrationRoot);
  const entry = manifestEntryById(manifest, migrationId);
  if (entry?.ops && entry.ops.length > 0) {
    return entry.ops;
  }

  const sql = await readMigrationSql(migrationRoot, migrationId);
  if (!sql) {
    return null;
  }

  return splitSqlStatements(sql).map((statement) => ({
    kind: "sql" as const,
    statement,
  }));
}

/** True when migration file/manifest defines executable schema changes. */
export async function migrationHasExecutableOps(
  migrationRoot: string,
  migrationId: string,
): Promise<boolean> {
  const ops = await migrationOpsFromRoot(migrationRoot, migrationId);
  return ops !== null && ops.length > 0;
}

/** Post-push verify: only check migrations sync would actually apply. */
export async function shouldVerifyMigrationOnRemote(
  migrationRoot: string,
  migrationId: string,
): Promise<boolean> {
  if (shouldSkipMigrationForRemoteLedger(migrationId)) {
    return false;
  }
  return migrationHasExecutableOps(migrationRoot, migrationId);
}
