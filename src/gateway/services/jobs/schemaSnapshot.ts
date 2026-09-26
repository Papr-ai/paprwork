/**
 * Schema snapshot: the publisher's exact schema, captured at publish time, so a
 * fresh install builds its database from one known-good schema instead of
 * replaying every migration ever written (the replay is where forks drifted
 * and broke — LinkedIn Outreach 0002).
 *
 * Stored at data/databases/{slug}/migrations/snapshot.json. Living in
 * migrations/ means the existing publish, copy and install paths carry it
 * untouched; migration runners only read *.sql, so they never execute it.
 *
 * Contents:
 *   migrations — every migration the snapshot already contains, with the
 *                sha256 of its raw file. An install uses the snapshot ONLY if
 *                every listed file still exists with the same hash; otherwise
 *                it falls back to normal replay (never a half-trusted mix).
 *   schema     — CREATE statements from sqlite_master, tables first.
 *   seed       — optional publisher-authored data/databases/{slug}/seed.sql.
 *                Never the publisher's rows: forks must not receive their data.
 *                May use {{papr.owner_user_id}}.
 */

import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";

export const SCHEMA_SNAPSHOT_FILE = "snapshot.json";
export const SCHEMA_SNAPSHOT_FORMAT = 1;
export const SEED_FILE = "seed.sql";

export interface SchemaSnapshotMigration {
  file: string;
  sha256: string;
}

export interface SchemaSnapshot {
  formatVersion: typeof SCHEMA_SNAPSHOT_FORMAT;
  migrations: SchemaSnapshotMigration[];
  schema: string[];
  seed?: string;
  generatedAt: string;
}

export interface SchemaObjectRow {
  type: string;
  name: string;
  tbl_name?: string;
  sql: string | null;
}

export function sha256Of(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Platform/engine objects never belong in an app schema. */
export function isInternalSchemaObject(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.startsWith("sqlite_") ||
    lower.startsWith("_papr_") ||
    lower.startsWith("turso_") ||
    lower.startsWith("libsql_") ||
    lower.startsWith("_litestream") ||
    lower === "schema_migrations"
  );
}

const TYPE_ORDER: Record<string, number> = { table: 0, view: 1, index: 2, trigger: 3 };

/** sqlite_master rows (creation order) → ordered CREATE statements. */
export function schemaStatementsFromRows(rows: readonly SchemaObjectRow[]): string[] {
  return rows
    .map((row, position) => ({ row, position }))
    .filter(({ row }) => {
      if (!row.sql || !(row.type in TYPE_ORDER)) {
        return false;
      }
      if (isInternalSchemaObject(row.name)) {
        return false;
      }
      return !(row.tbl_name && isInternalSchemaObject(row.tbl_name));
    })
    .sort(
      (a, b) =>
        TYPE_ORDER[a.row.type] - TYPE_ORDER[b.row.type] || a.position - b.position,
    )
    .map(({ row }) => row.sql!.trim().replace(/;+\s*$/, ""));
}

export async function listMigrationFiles(migrationRoot: string): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(migrationRoot, "migrations")))
      .filter((name) => name.endsWith(".sql"))
      .sort();
  } catch {
    return [];
  }
}

async function readRaw(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

function bareId(fileOrId: string): string {
  return fileOrId.replace(/\.sql$/, "");
}

/**
 * Build a snapshot, or null when the publisher's database is not in a state a
 * snapshot can describe honestly: nothing applied, or the applied set is not a
 * prefix of the migration files (a gap means the schema is not "migrations
 * 0001..N" and marking them applied on an installer would be a lie).
 */
export async function buildSchemaSnapshot(input: {
  migrationRoot: string;
  schemaRows: readonly SchemaObjectRow[];
  appliedLedgerIds: ReadonlySet<string>;
  now?: Date;
}): Promise<SchemaSnapshot | null> {
  const files = await listMigrationFiles(input.migrationRoot);
  const isApplied = (file: string) =>
    input.appliedLedgerIds.has(file) || input.appliedLedgerIds.has(bareId(file));

  const covered: SchemaSnapshotMigration[] = [];
  let gapSeen = false;
  for (const file of files) {
    if (!isApplied(file)) {
      gapSeen = true;
      continue;
    }
    if (gapSeen) {
      return null;
    }
    const raw = await readRaw(path.join(input.migrationRoot, "migrations", file));
    if (raw === null) {
      return null;
    }
    covered.push({ file, sha256: sha256Of(raw) });
  }
  const schema = schemaStatementsFromRows(input.schemaRows);
  if (covered.length === 0 || schema.length === 0) {
    return null;
  }
  const seed = await readRaw(path.join(input.migrationRoot, SEED_FILE));
  return {
    formatVersion: SCHEMA_SNAPSHOT_FORMAT,
    migrations: covered,
    schema,
    ...(seed?.trim() ? { seed } : {}),
    generatedAt: (input.now ?? new Date()).toISOString(),
  };
}

function snapshotPath(migrationRoot: string): string {
  return path.join(migrationRoot, "migrations", SCHEMA_SNAPSHOT_FILE);
}

/** Content identity ignoring generatedAt — so republishing unchanged schema is a no-op. */
function snapshotContentKey(snapshot: SchemaSnapshot): string {
  const { generatedAt: _ignored, ...rest } = snapshot;
  return JSON.stringify(rest);
}

/** Write (or remove, when null) the snapshot. Returns true when the file changed. */
export async function writeSchemaSnapshot(
  migrationRoot: string,
  snapshot: SchemaSnapshot | null,
): Promise<boolean> {
  const file = snapshotPath(migrationRoot);
  const previous = await readSchemaSnapshot(migrationRoot);
  if (!snapshot) {
    if (!previous) {
      return false;
    }
    await fs.rm(file, { force: true });
    return true;
  }
  if (previous && snapshotContentKey(previous) === snapshotContentKey(snapshot)) {
    return false;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return true;
}

export async function readSchemaSnapshot(
  migrationRoot: string,
): Promise<SchemaSnapshot | null> {
  const raw = await readRaw(snapshotPath(migrationRoot));
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as SchemaSnapshot;
    if (
      parsed?.formatVersion !== SCHEMA_SNAPSHOT_FORMAT ||
      !Array.isArray(parsed.migrations) ||
      !Array.isArray(parsed.schema)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The snapshot is usable only if every migration it claims still exists with
 * the same content. Returns the reason when it is not.
 */
export async function validateSchemaSnapshot(
  migrationRoot: string,
  snapshot: SchemaSnapshot,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  for (const entry of snapshot.migrations) {
    const raw = await readRaw(path.join(migrationRoot, "migrations", entry.file));
    if (raw === null) {
      return { ok: false, reason: `${entry.file} is missing` };
    }
    if (sha256Of(raw) !== entry.sha256) {
      return { ok: false, reason: `${entry.file} changed after the snapshot was taken` };
    }
  }
  return { ok: true };
}
