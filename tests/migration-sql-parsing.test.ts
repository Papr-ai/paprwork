import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import {
  parseAddColumnStatement,
  parseCreateIndexStatement,
  parseCreateTableStatement,
  parseDropStatement,
  splitSqlStatements,
} from "../src/gateway/services/jobs/migrationSqlHelpers.js";
import { verifyMigrationOnLocal } from "../src/gateway/services/jobs/jobMigrationLedgerSync.js";

// Native better-sqlite3 is unavailable when the ABI does not match the local
// Node build; match the existing suites and skip rather than fail.
let canUseBetterSqlite = false;
try {
  const probe = new Database(":memory:");
  probe.close();
  canUseBetterSqlite = true;
} catch {
  canUseBetterSqlite = false;
}

/** Returns the job dir; readMigrationSql appends `migrations/` itself. */
async function writeMigration(id: string, sql: string): Promise<string> {
  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), "papr-migsql-"));
  const dir = path.join(jobDir, "migrations");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, id), sql, "utf8");
  return jobDir;
}

describe("migration SQL parsing", () => {
  describe("CREATE TABLE identifiers", () => {
    // Regression: `(\S+)` captured "foo(" and the sqlite_master lookup never matched,
    // so every such migration was reported unsatisfied forever.
    it("parses a table name with no space before the paren", () => {
      expect(
        parseCreateTableStatement("CREATE TABLE dev_plans(id INTEGER)"),
      ).toEqual({ table: "dev_plans" });
      expect(
        parseCreateTableStatement(
          "CREATE TABLE IF NOT EXISTS dev_plans(\n  id INTEGER PRIMARY KEY\n)",
        ),
      ).toEqual({ table: "dev_plans" });
    });

    it("parses spaced, quoted, bracketed and temp variants", () => {
      const cases: Array<[string, string]> = [
        ["CREATE TABLE dev_plans (id INTEGER)", "dev_plans"],
        ['CREATE TABLE "dev plans" (id INTEGER)', "dev plans"],
        ["CREATE TABLE [dev plans] (id INTEGER)", "dev plans"],
        ["CREATE TABLE `dev plans` (id INTEGER)", "dev plans"],
        ["CREATE TEMPORARY TABLE scratch(id INTEGER)", "scratch"],
      ];
      for (const [sql, expected] of cases) {
        expect(parseCreateTableStatement(sql)?.table).toBe(expected);
      }
    });

    it("ignores non-CREATE-TABLE statements", () => {
      expect(parseCreateTableStatement("SELECT 1")).toBeNull();
      expect(
        parseCreateTableStatement("CREATE INDEX i ON t (a)"),
      ).toBeNull();
    });
  });

  describe("CREATE INDEX identifiers", () => {
    it("parses index names regardless of spacing or quoting", () => {
      expect(parseCreateIndexStatement("CREATE INDEX idx_a ON t(a)")).toEqual({
        indexName: "idx_a",
      });
      expect(
        parseCreateIndexStatement(
          "CREATE UNIQUE INDEX IF NOT EXISTS idx_a ON t (a)",
        ),
      ).toEqual({ indexName: "idx_a" });
    });
  });

  describe("ADD COLUMN", () => {
    it("parses with and without the optional COLUMN keyword", () => {
      expect(
        parseAddColumnStatement("ALTER TABLE csms ADD COLUMN email TEXT"),
      ).toEqual({ table: "csms", column: "email" });
      // COLUMN is optional in SQLite.
      expect(parseAddColumnStatement("ALTER TABLE csms ADD email TEXT")).toEqual(
        { table: "csms", column: "email" },
      );
    });
  });

  describe("DROP statements", () => {
    // Regression: DROP fell through to `return false`, so any migration
    // containing one could never be satisfied on Turso.
    it("parses DROP TABLE and DROP INDEX", () => {
      expect(parseDropStatement("DROP INDEX IF EXISTS idx_a")).toEqual({
        objectType: "index",
        name: "idx_a",
      });
      expect(parseDropStatement("DROP TABLE old_table")).toEqual({
        objectType: "table",
        name: "old_table",
      });
    });

    it("does not treat DROP COLUMN as a table/index drop", () => {
      expect(
        parseDropStatement("ALTER TABLE t DROP COLUMN c"),
      ).toBeNull();
    });
  });

  describe("splitSqlStatements", () => {
    // Regression: splitting on ";" before stripping comments turned a semicolon
    // inside a comment into a statement boundary, emitting invalid SQL that the
    // appliers then executed (SQL_PARSE_ERROR).
    it("ignores semicolons inside line comments", () => {
      const statements = splitSqlStatements(
        "-- verifier knows CREATE TABLE; a DROP cannot be checked\nCREATE INDEX idx_a ON t (a);",
      );
      expect(statements).toEqual(["CREATE INDEX idx_a ON t (a)"]);
    });

    it("ignores semicolons inside block comments", () => {
      const statements = splitSqlStatements(
        "/* note; with semicolon */\nCREATE TABLE t (a TEXT);",
      );
      expect(statements).toEqual(["CREATE TABLE t (a TEXT)"]);
    });

    it("ignores semicolons inside string literals", () => {
      const statements = splitSqlStatements(
        "CREATE TABLE t (a TEXT DEFAULT 'x;y');",
      );
      expect(statements).toEqual([
        "CREATE TABLE t (a TEXT DEFAULT 'x;y')",
      ]);
    });

    it("handles escaped quotes inside string literals", () => {
      const statements = splitSqlStatements(
        "INSERT INTO t (a) VALUES ('it''s; fine');",
      );
      expect(statements).toEqual(["INSERT INTO t (a) VALUES ('it''s; fine')"]);
    });

    it("still splits real multi-statement migrations", () => {
      const statements = splitSqlStatements(
        "CREATE TABLE t (a TEXT);\nCREATE INDEX idx_a ON t (a);",
      );
      expect(statements).toHaveLength(2);
    });

    it.skipIf(!canUseBetterSqlite)("keeps every emitted statement executable by SQLite", () => {
      const db = new Database(":memory:");
      const sql =
        "-- setup; with a semicolon in the comment\n" +
        "CREATE TABLE t (a TEXT DEFAULT 'x;y');\n" +
        "CREATE INDEX IF NOT EXISTS idx_a ON t (a);";
      for (const statement of splitSqlStatements(sql)) {
        expect(() => db.exec(statement)).not.toThrow();
      }
      db.close();
    });
  });

  describe("verifyMigrationOnLocal", () => {
    it.skipIf(!canUseBetterSqlite)("verifies a paren-tight CREATE TABLE that previously failed", async () => {
      const dir = await writeMigration(
        "0004_dev_plans.sql",
        "CREATE TABLE IF NOT EXISTS dev_plans(\n  id INTEGER PRIMARY KEY,\n  csm TEXT NOT NULL\n);",
      );
      const db = new Database(":memory:");
      db.exec("CREATE TABLE dev_plans (id INTEGER PRIMARY KEY, csm TEXT)");

      const result = await verifyMigrationOnLocal(db, dir, "0004_dev_plans.sql");
      expect(result.satisfied).toBe(true);
      expect(result.unverifiable).toEqual([]);
      db.close();
    });

    it.skipIf(!canUseBetterSqlite)("treats a DROP as satisfied once the object is gone", async () => {
      const dir = await writeMigration(
        "0006_fix_index.sql",
        "DROP INDEX IF EXISTS idx_old;\nCREATE INDEX IF NOT EXISTS idx_new ON t (a);",
      );
      const db = new Database(":memory:");
      db.exec("CREATE TABLE t (a TEXT); CREATE INDEX idx_new ON t (a)");

      const result = await verifyMigrationOnLocal(db, dir, "0006_fix_index.sql");
      expect(result.satisfied).toBe(true);
      db.close();
    });

    // Drop-and-recreate: per-statement the DROP looks unsatisfied because the
    // index exists again. Only the migration's final state matters.
    it.skipIf(!canUseBetterSqlite)("accepts DROP followed by CREATE of the same index", async () => {
      const dir = await writeMigration(
        "0006_fix_turso_period_index.sql",
        "-- Fix drift: verifier understands CREATE TABLE; a DROP could not be checked\n" +
          "DROP INDEX IF EXISTS idx_hist_period;\n" +
          "CREATE INDEX IF NOT EXISTS idx_hist_period ON assessment_history(period, csm);",
      );
      const db = new Database(":memory:");
      db.exec("CREATE TABLE assessment_history (csm TEXT, period TEXT)");
      db.exec("CREATE INDEX idx_hist_period ON assessment_history(period, csm)");

      const result = await verifyMigrationOnLocal(
        db,
        dir,
        "0006_fix_turso_period_index.sql",
      );
      expect(result.satisfied).toBe(true);
      db.close();
    });

    it.skipIf(!canUseBetterSqlite)("reports a DROP as unsatisfied while the object still exists", async () => {
      const dir = await writeMigration(
        "0007_drop_old.sql",
        "DROP TABLE IF EXISTS legacy;",
      );
      const db = new Database(":memory:");
      db.exec("CREATE TABLE legacy (a TEXT)");

      const result = await verifyMigrationOnLocal(db, dir, "0007_drop_old.sql");
      expect(result.satisfied).toBe(false);
      db.close();
    });

    it.skipIf(!canUseBetterSqlite)("warns instead of failing for statements it cannot introspect", async () => {
      const dir = await writeMigration(
        "0008_seed.sql",
        "CREATE TABLE IF NOT EXISTS t (a TEXT);\nINSERT INTO t (a) VALUES ('seed');",
      );
      const db = new Database(":memory:");
      db.exec("CREATE TABLE t (a TEXT)");

      const result = await verifyMigrationOnLocal(db, dir, "0008_seed.sql");
      expect(result.satisfied).toBe(true);
      expect(result.unverifiable).toHaveLength(1);
      expect(result.unverifiable[0]).toContain("INSERT INTO t");
      db.close();
    });

    it.skipIf(!canUseBetterSqlite)("still fails when a required table is genuinely missing", async () => {
      const dir = await writeMigration(
        "0009_new_table.sql",
        "CREATE TABLE IF NOT EXISTS missing_table (a TEXT);",
      );
      const db = new Database(":memory:");

      const result = await verifyMigrationOnLocal(db, dir, "0009_new_table.sql");
      expect(result.satisfied).toBe(false);
      db.close();
    });
  });
});
