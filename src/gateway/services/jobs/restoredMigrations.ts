/**
 * Restoring a migration file that is recorded as applied but missing on disk.
 *
 * Applied migrations are read-only, so an agent cannot "recreate" one. When the
 * file is simply absent (the owner's own copy never had it, or an older install
 * kept it in a different folder) this is the one sanctioned way to put it back:
 * the ledger must say it was applied, the file must be absent, and the SQL must
 * match the live schema. Each restore is recorded in restored-migrations.json
 * (beside migrations/, never inside it) so a later proposal can tell a restored
 * file from a new one.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export const RESTORED_MANIFEST_FILE = "restored-migrations.json";

/** Ledger ids that never have a file: internal bookkeeping rows. */
export function ledgerIdNeedsFile(id: string): boolean {
  const bare = id.replace(/\.sql$/i, "");
  return !(bare.startsWith("__") || bare === "workspace_log" || bare === "0001_baseline");
}

/** Applied ids whose .sql file is missing. Pure. */
export function appliedWithoutFile(
  appliedIds: Iterable<string>,
  fileNames: Iterable<string>,
): string[] {
  const files = new Set([...fileNames].map((f) => f.replace(/\.sql$/i, "")));
  return [...new Set([...appliedIds].map((i) => i.replace(/\.sql$/i, "")))]
    .filter((id) => ledgerIdNeedsFile(id) && !files.has(id))
    .sort();
}

export interface SchemaExpectation {
  table: string;
  column?: string;
}

/** Tables / columns the SQL creates. Pure and deliberately conservative. */
export function expectedSchemaFromSql(sql: string): SchemaExpectation[] {
  const out: SchemaExpectation[] = [];
  const body = sql.replace(/--[^\n]*/g, "");
  const create = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi;
  const alter = /ALTER\s+TABLE\s+["`]?(\w+)["`]?\s+ADD\s+(?:COLUMN\s+)?["`]?(\w+)["`]?/gi;
  let m: RegExpExecArray | null;
  while ((m = create.exec(body))) out.push({ table: m[1]! });
  while ((m = alter.exec(body))) out.push({ table: m[1]!, column: m[2]! });
  return out;
}

/**
 * Check the SQL's effects exist in the live schema. Returns the missing items;
 * an empty list means "consistent". A file that creates nothing we can verify
 * (pure data change) returns `unverifiable: true` so the caller can require an
 * explicit source rather than guessing.
 */
export function checkSqlAgainstSchema(
  sql: string,
  live: Map<string, Set<string>>,
): { missing: string[]; unverifiable: boolean } {
  const expected = expectedSchemaFromSql(sql);
  if (expected.length === 0) return { missing: [], unverifiable: true };
  const missing: string[] = [];
  for (const e of expected) {
    const cols = live.get(e.table.toLowerCase());
    if (!cols) missing.push(e.table);
    else if (e.column && !cols.has(e.column.toLowerCase())) missing.push(`${e.table}.${e.column}`);
  }
  return { missing, unverifiable: false };
}

export interface RestoredMigrationRecord {
  id: string;
  sha256: string;
  source: string;
  restoredAt: string;
}

export function hashSql(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n").trimEnd()).digest("hex");
}

export async function readRestoredManifest(migrationRoot: string): Promise<RestoredMigrationRecord[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(migrationRoot, RESTORED_MANIFEST_FILE), "utf8"));
    return Array.isArray(parsed?.restored) ? parsed.restored : [];
  } catch {
    return [];
  }
}

/** Write the file (never overwrite) and record provenance. */
export async function writeRestoredMigration(input: {
  migrationRoot: string;
  migrationId: string;
  sql: string;
  source: string;
  now?: Date;
}): Promise<{ fullPath: string; record: RestoredMigrationRecord }> {
  const dir = path.join(input.migrationRoot, "migrations");
  await fs.mkdir(dir, { recursive: true });
  const fullPath = path.join(dir, `${input.migrationId}.sql`);
  await fs.writeFile(fullPath, input.sql, { flag: "wx" });
  const record: RestoredMigrationRecord = {
    id: input.migrationId,
    sha256: hashSql(input.sql),
    source: input.source,
    restoredAt: (input.now ?? new Date()).toISOString(),
  };
  const existing = (await readRestoredManifest(input.migrationRoot)).filter((r) => r.id !== record.id);
  await fs.writeFile(
    path.join(input.migrationRoot, RESTORED_MANIFEST_FILE),
    `${JSON.stringify({ version: 1, restored: [...existing, record] }, null, 2)}\n`,
  );
  return { fullPath, record };
}
