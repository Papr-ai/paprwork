/**
 * Try a proposal's new migrations on a throwaway test copy of the team's data:
 * the real schema plus up to 100 rows per table (decided in the Preview Mode
 * plan). The contributor's real copy is never changed by a proposal (audit A,
 * B, F2); approval re-runs the change on the full team database (audit H).
 */
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import Database from "better-sqlite3";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import { splitSqlStatements } from "../jobs/migrationSqlHelpers.js";

export const TEST_COPY_ROWS = 100;

export type ReadQuery = (sql: string) => Promise<{ rows: Record<string, unknown>[] } | null>;

export interface TestCopyMigration {
  id: string;
  sql: string;
}

export interface TestCopyResult {
  /** Ran cleanly on the test copy, in order. */
  passed: string[];
  /** First failure; later migrations were not tried. */
  failed?: { id: string; error: string };
}

/** Replica reads can return blobs as ArrayBuffer/typed arrays; better-sqlite3 binds Buffers. */
function sqliteValue(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof ArrayBuffer) return Buffer.from(v);
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (typeof v === "object") return JSON.stringify(v);
  return v;
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Build the test copy at `file` from the source's schema and sample rows. */
export async function buildTestCopy(read: ReadQuery, file: string, rowsPerTable = TEST_COPY_ROWS): Promise<void> {
  const master = await read(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' " +
      "ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END",
  );
  if (!master) throw new Error("couldn't read this copy's schema");
  const db = new Database(file);
  try {
    const objects = master.rows.map((r) => ({ type: String(r.type), name: String(r.name), sql: String(r.sql) }));
    for (const t of objects.filter((o) => o.type === "table")) {
      db.exec(t.sql);
      const sample = await read(`SELECT * FROM ${q(t.name)} LIMIT ${Math.max(0, rowsPerTable)}`);
      const rows = sample?.rows ?? [];
      if (rows.length === 0) continue;
      const cols = Object.keys(rows[0]!);
      const insert = db.prepare(
        `INSERT OR IGNORE INTO ${q(t.name)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      );
      db.transaction(() => {
        for (const row of rows) insert.run(...cols.map((c) => sqliteValue(row[c]) as never));
      })();
    }
    // Indexes, views and triggers after the rows, so triggers don't fire on the sample.
    for (const o of objects.filter((x) => x.type !== "table")) {
      try {
        db.exec(o.sql);
      } catch {
        /* an object the sample can't satisfy (e.g. a unique index over trimmed rows) is skipped */
      }
    }
  } finally {
    db.close();
  }
}

/** Run each migration in its own transaction, in order; stop at the first failure. */
export async function testMigrationsOnTestCopy(
  read: ReadQuery,
  migrations: readonly TestCopyMigration[],
  rowsPerTable = TEST_COPY_ROWS,
): Promise<TestCopyResult> {
  const result: TestCopyResult = { passed: [] };
  if (migrations.length === 0) return result;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "papr-test-copy-"));
  const file = path.join(dir, "test-copy.db");
  try {
    await buildTestCopy(read, file, rowsPerTable);
    const db = new Database(file);
    try {
      Object.assign(result, applyMigrationsToTestCopy(db, migrations));
    } finally {
      db.close();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  return result;
}

// ── Contributor on the team's shared data ─────────────────────────────────
// A new migration is never applied to the real copy. Every migration file not
// yet in this copy's ledger runs, in order, on a test copy; the ones that pass
// are recorded with their checksum so Propose can tell they were tested.


const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const bare = (id: string) => id.replace(/\.sql$/, "");

function manifestPath(dbId: string): string {
  return path.join(getPaprRoot(), "data", "proposal-tests", `${dbId}.json`);
}

async function readManifest(dbId: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(manifestPath(dbId), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

async function migrationFiles(migrationRoot: string): Promise<Array<{ id: string; sql: string }>> {
  const dir = path.join(migrationRoot, "migrations");
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".sql")).sort();
  return Promise.all(names.map(async (n) => ({ id: bare(n), sql: await fs.readFile(path.join(dir, n), "utf8") })));
}

export interface PendingTestInput {
  dbId: string;
  migrationRoot: string;
  /** Reads the real copy (read-only). */
  read: ReadQuery;
}

/** Migration files not yet on the team's database (this copy's ledger + the team ledger). */
export async function pendingMigrations(read: ReadQuery, migrationRoot: string): Promise<TestCopyMigration[]> {
  const ledger = await read("SELECT id FROM schema_migrations");
  if (!ledger) throw new Error("couldn't read this copy's migration ledger");
  const done = new Set(ledger.rows.map((r) => bare(String(r.id ?? ""))));
  // The team's ledger rides down with the shared data: those already ran on the team's database.
  const team = await read("SELECT id FROM _papr_schema_migrations").catch(() => null);
  for (const r of team?.rows ?? []) done.add(bare(String(r.id ?? "")));
  return (await migrationFiles(migrationRoot)).filter((m) => !done.has(m.id));
}

/** Run migrations in order on an open test copy; stop at the first failure. */
export function applyMigrationsToTestCopy(db: Database.Database, migrations: readonly TestCopyMigration[]): TestCopyResult {
  const result: TestCopyResult = { passed: [] };
  for (const m of migrations) {
    try {
      db.transaction(() => {
        for (const stmt of splitSqlStatements(m.sql)) db.exec(stmt);
      })();
      result.passed.push(m.id);
    } catch (err) {
      result.failed = { id: m.id, error: (err as Error).message.slice(0, 200) };
      break;
    }
  }
  return result;
}

/** Test every migration not in the real ledger, in order. Records the ones that passed. */
export async function testPendingMigrations(input: PendingTestInput): Promise<TestCopyResult & { pending: string[] }> {
  const pending = await pendingMigrations(input.read, input.migrationRoot);
  const result = await testMigrationsOnTestCopy(input.read, pending);
  const manifest: Record<string, string> = {};
  for (const m of pending) if (result.passed.includes(m.id)) manifest[m.id] = sha(m.sql);
  await fs.mkdir(path.dirname(manifestPath(input.dbId)), { recursive: true });
  await fs.writeFile(manifestPath(input.dbId), JSON.stringify(manifest, null, 2));
  return { ...result, pending: pending.map((m) => m.id) };
}

/** Migration ids that passed on a test copy and whose file hasn't changed since. */
export async function testedMigrationIds(dbId: string, migrationRoot: string): Promise<Set<string>> {
  const manifest = await readManifest(dbId);
  const ids = new Set<string>();
  for (const m of await migrationFiles(migrationRoot)) if (manifest[m.id] === sha(m.sql)) ids.add(m.id);
  return ids;
}
