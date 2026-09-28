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
import { migrationWritesRows, splitSqlStatements } from "./migrationSqlHelpers.js";

export const SCHEMA_SNAPSHOT_FILE = "snapshot.json";
export const SCHEMA_SNAPSHOT_FORMAT = 1;
export const SEED_FILE = "seed.sql";

/** A row-writing statement carried from a covered migration into the snapshot. */
export interface SchemaSnapshotRowWrite {
  /** Target table (lower-case) — must exist, unreshaped, in the final schema. */
  table: string;
  sql: string;
}

export interface SchemaSnapshotMigration {
  file: string;
  sha256: string;
  /**
   * Row writes extracted from this migration at publish (e.g. singleton seeds),
   * replayed after the schema DDL on install. Present (possibly empty) on every
   * entry written by an extracting publisher; absent on older snapshots, which
   * installers then check the old way. Doubles as the publish-side cache: an
   * unchanged file (same sha256) reuses these instead of being re-parsed.
   */
  rows?: SchemaSnapshotRowWrite[];
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

const IDENT = String.raw`["\`\[]?(\w+)["\`\]]?`;
const INSERT_TARGET = new RegExp(String.raw`^(?:INSERT|REPLACE)(?:\s+OR\s+\w+)?\s+INTO\s+${IDENT}`, "i");
const UPDATE_TARGET = new RegExp(String.raw`^UPDATE(?:\s+OR\s+\w+)?\s+${IDENT}`, "i");
const DELETE_TARGET = new RegExp(String.raw`^DELETE\s+FROM\s+${IDENT}`, "i");
const ALTER_RESHAPE = new RegExp(String.raw`^ALTER\s+TABLE\s+${IDENT}\s+(?:RENAME|DROP)\b`, "i");
const RENAME_TO = new RegExp(String.raw`\bRENAME\s+TO\s+${IDENT}`, "i");
const DROP_TABLE = new RegExp(String.raw`^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${IDENT}`, "i");

function bareSql(statement: string): string {
  return statement.replace(/'(?:[^']|'')*'/g, "''").replace(/\s+/g, " ").trim();
}

type RowWriteKind =
  | { kind: "none" }
  | { kind: "write"; table: string }
  | { kind: "unsupported" };

/**
 * Top-level row write we can carry: INSERT/REPLACE … VALUES, UPDATE, DELETE
 * on one named table. Anything reading other tables (… SELECT, CTEs) depends
 * on replay-time state, so it is unsupported and the snapshot falls back.
 */
function classifyRowWrite(statement: string): RowWriteKind {
  const bare = bareSql(statement);
  if (/^CREATE\b/i.test(bare)) {
    return { kind: "none" };
  }
  const match =
    bare.match(INSERT_TARGET) ?? bare.match(UPDATE_TARGET) ?? bare.match(DELETE_TARGET);
  if (match) {
    return /\bSELECT\b/i.test(bare)
      ? { kind: "unsupported" }
      : { kind: "write", table: match[1].toLowerCase() };
  }
  return migrationWritesRows(statement) ? { kind: "unsupported" } : { kind: "none" };
}

/** Tables a statement renames, drops, or drops/renames columns of. */
function reshapedTables(statement: string): string[] {
  const bare = bareSql(statement);
  const out: string[] = [];
  const alter = bare.match(ALTER_RESHAPE);
  if (alter) {
    out.push(alter[1]);
    const to = bare.match(RENAME_TO);
    if (to) {
      out.push(to[1]);
    }
  }
  const drop = bare.match(DROP_TABLE);
  if (drop) {
    out.push(drop[1]);
  }
  return out.map((name) => name.toLowerCase());
}

/**
 * Parse one migration: its row writes, and whether it reshapes a table that
 * already has carried rows (earlier migrations, or earlier in this file) —
 * replaying those rows against the FINAL schema would then be wrong.
 */
function extractRowWrites(
  raw: string,
  seededTables: Set<string>,
): SchemaSnapshotRowWrite[] | null {
  const rows: SchemaSnapshotRowWrite[] = [];
  for (const statement of splitSqlStatements(raw)) {
    if (reshapedTables(statement).some((table) => seededTables.has(table))) {
      return null;
    }
    const kind = classifyRowWrite(statement);
    if (kind.kind === "unsupported") {
      return null;
    }
    if (kind.kind === "write") {
      rows.push({ table: kind.table, sql: statement });
      seededTables.add(kind.table);
    }
  }
  return rows;
}

/**
 * Build a snapshot, or null when the publisher's database is not in a state a
 * snapshot can describe honestly: nothing applied, a gap in the applied set
 * (the schema is not "migrations 0001..N" and marking them applied on an
 * installer would be a lie), or a covered migration writes rows the snapshot
 * cannot carry faithfully (see extractRowWrites).
 *
 * Row writes are extracted incrementally: while the covered files match the
 * previous snapshot (same file, same sha256, in order), their cached `rows`
 * are reused without parsing. Parsing starts at the first new/changed file —
 * normally only the migrations added since the last publish.
 */
export async function buildSchemaSnapshot(input: {
  migrationRoot: string;
  schemaRows: readonly SchemaObjectRow[];
  appliedLedgerIds: ReadonlySet<string>;
  now?: Date;
  /** Defaults to the snapshot.json on disk. Pass null to force a full parse. */
  previous?: SchemaSnapshot | null;
}): Promise<SchemaSnapshot | null> {
  const files = await listMigrationFiles(input.migrationRoot);
  const isApplied = (file: string) =>
    input.appliedLedgerIds.has(file) || input.appliedLedgerIds.has(bareId(file));
  const previous =
    input.previous === undefined
      ? await readSchemaSnapshot(input.migrationRoot)
      : input.previous;
  const cached = previous?.migrations ?? [];

  const covered: SchemaSnapshotMigration[] = [];
  const seededTables = new Set<string>();
  let cacheValid = true;
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
    const sha256 = sha256Of(raw);
    const hit = cacheValid ? cached[covered.length] : undefined;
    if (hit && hit.file === file && hit.sha256 === sha256 && Array.isArray(hit.rows)) {
      for (const row of hit.rows) {
        seededTables.add(row.table);
      }
      covered.push({ file, sha256, rows: hit.rows });
      continue;
    }
    cacheValid = false; // dirty from here on: parse this and every later file
    const rows = extractRowWrites(raw, seededTables);
    if (!rows) {
      return null;
    }
    covered.push({ file, sha256, rows });
  }
  const schema = schemaStatementsFromRows(input.schemaRows);
  if (covered.length === 0 || schema.length === 0) {
    return null;
  }
  const finalTables = new Set(
    input.schemaRows
      .filter((row) => row.type === "table")
      .map((row) => row.name.toLowerCase()),
  );
  if ([...seededTables].some((table) => !finalTables.has(table))) {
    return null; // rows target a table the final schema no longer has
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
    // Entries with `rows` were extracted at publish from exactly this content
    // (sha256 matched above) — no need to re-parse on every install. Only
    // older snapshots (no `rows`) get the structure-only check.
    if (!Array.isArray(entry.rows) && migrationWritesRows(raw)) {
      // Snapshots published before this check could cover a seeding migration.
      return {
        ok: false,
        reason: `${entry.file} inserts rows, which a schema snapshot cannot carry`,
      };
    }
  }
  return { ok: true };
}
