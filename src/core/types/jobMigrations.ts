/**
 * Database migration metadata — local source of truth for schema evolution.
 *
 * Flow:
 * 1. SQL files in {migrationRoot}/migrations/*.sql
 *    - Registry (app DB): data/databases/{slug}/migrations/
 *    - Job scratch: Jobs/{id}/migrations/ (infra only)
 * 2. manifest.json describes intent (optional explicit ops for Turso replay)
 * 3. Local apply via applyDatabaseMigrations(); Turso replay on sync push
 */

export const JOB_MIGRATION_MANIFEST_FILE = "manifest.json";
export const JOB_MIGRATION_MANIFEST_VERSION = 1 as const;

/** Explicit schema operation — Turso replay uses these when present instead of guessing from diffs. */
export type JobMigrationSchemaOp =
  | {
      kind: "add_column";
      table: string;
      column: string;
      type: string;
    }
  | {
      kind: "drop_column";
      table: string;
      column: string;
    }
  | {
      kind: "rename_column";
      table: string;
      from: string;
      to: string;
    }
  | {
      kind: "sql";
      /** Turso-safe DDL/DML statements (one migration step). */
      statement: string;
    };

export interface JobMigrationEntry {
  /** Must match the migrations/*.sql filename (e.g. 0002_add_contact.sql). */
  id: string;
  description?: string;
  /**
   * Optional checksum of the SQL file (sha256 hex). When set, local apply verifies
   * the file has not changed after being recorded in schema_migrations.
   */
  checksum?: string;
  /**
   * Explicit ops for Turso. When omitted, Turso replay runs the SQL file contents.
   * Use ops for renames and multi-step changes that raw diff cannot infer.
   */
  ops?: JobMigrationSchemaOp[];
}

export interface JobMigrationManifest {
  formatVersion: typeof JOB_MIGRATION_MANIFEST_VERSION;
  /** Informational schema version for apps/data-contract.json — bump when adding migrations. */
  schemaVersion: number;
  migrations: JobMigrationEntry[];
}

export const PAPR_ROW_SYNC_COLUMNS = {
  /** Set once at insert (platform-managed; use instead of requiring agent created_at). */
  createdAt: "_papr_created_at",
  updatedAt: "_papr_updated_at",
  rowVersion: "_papr_row_version",
} as const;
