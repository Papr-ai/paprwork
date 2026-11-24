/**
 * Try a proposal's new migrations on a throwaway test copy of the team's data:
 * the real schema plus up to 100 rows per table (decided in the Preview Mode
 * plan). The contributor's real copy is never changed by a proposal (audit A,
 * B, F2); approval re-runs the change on the full team database (audit H).
 */
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
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
        for (const row of rows) insert.run(...cols.map((c) => (row[c] === undefined ? null : row[c]) as never));
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
    } finally {
      db.close();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  return result;
}
