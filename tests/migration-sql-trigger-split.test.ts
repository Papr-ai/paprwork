import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  migrationRerunSafety,
  migrationWritesRows,
  splitSqlStatements,
} from "../src/gateway/services/jobs/migrationSqlHelpers.js";

// Vite cannot resolve node:sqlite as an ESM import; load it like install-scenario-matrix does.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/** Run each split piece on its own, the way the migration appliers do. */
function runPieces(sql: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const statement of splitSqlStatements(sql)) db.exec(statement);
  return db;
}

const SEG = (row: "OLD" | "NEW") =>
  `CASE WHEN COALESCE(${row}.pw,0)=1 THEN 'paprwork' WHEN COALESCE(${row}.web,0)=1 THEN 'web' ELSE 'other' END`;

describe("splitSqlStatements keeps trigger bodies whole", () => {
  it("BEGIN … END with several body statements is one statement", () => {
    const sql = `CREATE TABLE t(a);
CREATE TRIGGER trg AFTER UPDATE ON t BEGIN INSERT INTO t VALUES (1); UPDATE t SET a = 2 WHERE 0; END;
SELECT 1;`;
    const parts = splitSqlStatements(sql);
    expect(parts).toHaveLength(3);
    expect(parts[1]).toMatch(/^CREATE TRIGGER trg[\s\S]*END$/);
    expect(() => runPieces(sql)).not.toThrow();
  });

  it("CASE … END in WHEN and body does not close the trigger early", () => {
    const sql = `CREATE TABLE c(id TEXT PRIMARY KEY, pw INT, web INT);
CREATE TABLE ch(id TEXT, f TEXT, t TEXT);
-- comment with END; inside
CREATE TRIGGER IF NOT EXISTS seg AFTER UPDATE OF pw, web ON c
WHEN (${SEG("OLD")}) != (${SEG("NEW")})
BEGIN
  INSERT INTO ch VALUES (NEW.id, ${SEG("OLD")}, ${SEG("NEW")});
  UPDATE ch SET t = t WHERE f = 'end;';
END;
INSERT INTO c VALUES ('u1', 0, 1);`;
    expect(splitSqlStatements(sql)).toHaveLength(4);
    const db = runPieces(sql);
    db.exec("UPDATE c SET pw = 1 WHERE id = 'u1'");
    expect(db.prepare("SELECT f, t FROM ch").all()).toEqual([{ f: "web", t: "paprwork" }]);
  });

  it("lowercase and TEMP triggers", () => {
    const sql = "create table t(a); create temp trigger y after insert on t begin select 1; end; select 2;";
    expect(splitSqlStatements(sql)).toHaveLength(3);
    expect(() => runPieces(sql)).not.toThrow();
  });

  it("BEGIN/END as identifiers or literals outside a trigger change nothing", () => {
    const sql = "CREATE TABLE begin_end(a); INSERT INTO begin_end VALUES ('BEGIN'); SELECT 'END';";
    expect(splitSqlStatements(sql)).toHaveLength(3);
  });

  it("an INSERT inside a trigger body is schema: safe to re-run, writes no rows", () => {
    const sql = "CREATE TRIGGER IF NOT EXISTS x AFTER INSERT ON t BEGIN INSERT INTO log VALUES (1); DELETE FROM q; END;";
    expect(migrationWritesRows(sql)).toBe(false);
    expect(migrationRerunSafety(sql).safe).toBe(true);
  });
});
