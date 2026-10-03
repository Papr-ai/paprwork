import { describe, expect, it } from "vitest";
import { classifyMigrationSql } from "../src/gateway/services/jobs/migrationBreakingClassifier.js";

const kinds = (sql: string) => classifyMigrationSql(sql).changes.map((c) => c.kind);

describe("classifyMigrationSql", () => {
  it("treats additive migrations as non-breaking", () => {
    const sql = `-- header
      CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT);
      ALTER TABLE notes ADD COLUMN pinned INTEGER DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_notes_pinned ON notes(pinned);
      DROP INDEX IF EXISTS idx_old;
      INSERT INTO notes (body) VALUES ('hi');`;
    expect(classifyMigrationSql(sql)).toEqual({ breaking: false, changes: [] });
  });

  it("flags drops and renames of pre-existing objects", () => {
    expect(kinds("DROP TABLE prospects;")).toEqual(["drop_table"]);
    expect(kinds("ALTER TABLE t DROP COLUMN legacy;")).toEqual(["drop_column"]);
    expect(kinds("ALTER TABLE replies RENAME COLUMN prospect_id TO member_id;")).toEqual(["rename_column"]);
    expect(kinds("ALTER TABLE a RENAME TO b;")).toEqual(["rename_table"]);
    expect(kinds("DROP VIEW IF EXISTS v_summary;")).toEqual(["drop_view_or_trigger"]);
  });

  it("collapses the SQLite rebuild idiom into one table_rebuild", () => {
    const sql = `CREATE TABLE audits_new (id INTEGER PRIMARY KEY, score INTEGER);
      INSERT INTO audits_new SELECT id, CAST(score AS INTEGER) FROM audits;
      DROP TABLE audits;
      ALTER TABLE audits_new RENAME TO audits;`;
    const r = classifyMigrationSql(sql);
    expect(r.breaking).toBe(true);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ kind: "table_rebuild", table: "audits" });
  });

  it("ignores scratch tables created and dropped within the same migration", () => {
    expect(kinds("CREATE TABLE tmp_x (id INTEGER); INSERT INTO tmp_x VALUES (1); DROP TABLE tmp_x;")).toEqual([]);
  });

  it("ignores platform-managed _papr_ triggers", () => {
    expect(kinds("DROP TRIGGER IF EXISTS _papr_bump_notes;")).toEqual([]);
  });

  it("ignores keywords inside comments", () => {
    expect(kinds("-- 0004 intended to RENAME and DROP TABLE x\nCREATE TABLE IF NOT EXISTS y (id INTEGER);")).toEqual([]);
  });
});
