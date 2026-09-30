/**
 * Fresh-install fast path: build an EMPTY database straight from the
 * publisher's schema snapshot (+ optional seed.sql), and record every
 * migration the snapshot covers as applied — in ONE transaction per backend.
 * Migrations newer than the snapshot then run through the normal runner.
 *
 * Guard rails (all must hold, otherwise normal replay runs unchanged):
 *   - snapshot.json exists and parses
 *   - every migration it covers still exists with the same sha256
 *   - the target database has no app tables AND an empty ledger
 * An existing database is never touched by this path; team shared primaries
 * always have tables, so they are never rebuilt from a snapshot.
 */

import { splitSqlStatements } from "./migrationSqlHelpers.js";
import { substituteMigrationPlaceholders } from "./migrationPlaceholders.js";
import {
  isInternalSchemaObject,
  readSchemaSnapshot,
  validateSchemaSnapshot,
} from "./schemaSnapshot.js";

export interface SnapshotInstallPlan {
  /** Schema DDL then seed statements, placeholders filled in. */
  statements: string[];
  /** Migration files the snapshot covers (e.g. "0002_rename.sql"). */
  coveredFiles: string[];
  /** Same, without .sql (the id form used by the replica/remote ledgers). */
  coveredIds: string[];
}

export async function planSnapshotInstall(
  migrationRoot: string,
): Promise<SnapshotInstallPlan | null> {
  const snapshot = await readSchemaSnapshot(migrationRoot);
  if (!snapshot) {
    return null;
  }
  const valid = await validateSchemaSnapshot(migrationRoot, snapshot);
  if (!valid.ok) {
    console.warn(
      `[SchemaSnapshot] Ignoring snapshot in ${migrationRoot}: ${valid.reason}. ` +
        "Replaying migrations instead.",
    );
    return null;
  }
  const seed = snapshot.seed
    ? splitSqlStatements(
        await substituteMigrationPlaceholders(snapshot.seed, migrationRoot),
      )
    : [];
  // Snapshots published before the builder filtered engine-private objects
  // can still carry them; drop at apply time so those installs work too.
  const schema = await Promise.all(
    snapshot.schema
      .filter((sql) => !isInternalSchemaStatement(sql))
      .map((sql) => substituteMigrationPlaceholders(sql, migrationRoot)),
  );
  // Row writes carried from covered migrations (e.g. singleton seeds), in
  // migration order, after the DDL and before the publisher's seed.sql.
  const migrationRows = await Promise.all(
    snapshot.migrations
      .flatMap((m) => m.rows ?? [])
      .map((row) => substituteMigrationPlaceholders(row.sql, migrationRoot)),
  );
  const coveredFiles = snapshot.migrations.map((m) => m.file);
  return {
    statements: [...schema, ...migrationRows, ...seed],
    coveredFiles,
    coveredIds: coveredFiles.map((file) => file.replace(/\.sql$/, "")),
  };
}

/** CREATE TABLE/INDEX/TRIGGER/VIEW whose object or target table is engine-internal. */
export function isInternalSchemaStatement(sql: string): boolean {
  const m = sql.match(
    /^\s*CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`\[]?([\w$]+)["`\]]?(?:[\s\S]*?\bON\s+["`\[]?([\w$]+))?/i,
  );
  if (!m) return false;
  return isInternalSchemaObject(m[1]) || (m[2] ? isInternalSchemaObject(m[2]) : false);
}

/** Table names from sqlite_master → true when no app table exists yet. */
export function hasNoAppTables(tableNames: readonly string[]): boolean {
  return tableNames.every((name) => isInternalSchemaObject(name));
}

export const FRESH_TABLES_SQL =
  "SELECT name FROM sqlite_master WHERE type = 'table'";
