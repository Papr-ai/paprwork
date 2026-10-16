/**
 * Scenario matrix for private tables (test plan §A, §C, §D).
 * Each case = one row of the plan. Failures here are real findings.
 */
import { describe, expect, it } from "vitest";
import {
  assertRawSqlAllowed,
  privateTablesWithViews,
} from "../src/gateway/services/appRuntime/tableAcl.js";
import { checkMiniAppTableAcl } from "../src/gateway/utils/miniAppTableAclLint.js";

const PRIV = new Set(["notes"]);
const blocked = (sql: string, priv: ReadonlySet<string> = PRIV) => {
  try {
    assertRawSqlAllowed(sql, priv);
    return false;
  } catch (e) {
    expect((e as { status?: number }).status).toBe(403);
    return true;
  }
};

describe("A. Host: raw browser SQL (non-owner)", () => {
  const mustBlock: Array<[string, string]> = [
    ["A1 plain select", "SELECT * FROM notes"],
    ["A2 uppercase name", "SELECT * FROM NOTES"],
    ["A3 double-quoted", 'SELECT * FROM "notes"'],
    ["A4 backticks", "SELECT * FROM `notes`"],
    ["A5 brackets", "SELECT * FROM [notes]"],
    ["A6 schema-qualified", "SELECT * FROM main.notes"],
    ["A7 join", "SELECT t.* FROM tags t JOIN notes n ON n.id=t.note_id"],
    ["A8 subquery", "SELECT (SELECT count(*) FROM notes) AS c"],
    ["A9 CTE", "WITH x AS (SELECT * FROM notes) SELECT * FROM x"],
    ["A10 union", "SELECT id FROM tags UNION SELECT id FROM notes"],
    ["A11 insert", "INSERT INTO notes(body) VALUES('x')"],
    ["A12 update", "UPDATE notes SET body='x'"],
    ["A13 delete", "DELETE FROM notes"],
    ["A14 comment trick", "SELECT * FROM/**/notes"],
    ["A15 newline/tab", "SELECT *\n\tFROM\n notes"],
    ["A16 pragma_table_info", "SELECT * FROM pragma_table_info('notes')"],
    ["A17 oplog", "SELECT * FROM _papr_oplog"],
    ["A18 turso cdc", "SELECT count(*) FROM turso_cdc"],
    ["A19 libsql internal", "SELECT * FROM libsql_wasm_func_table"],
    ["A20 insert…select copy-out", "INSERT INTO tags(name) SELECT body FROM notes"],
  ];
  for (const [name, sql] of mustBlock) it(`${name} → 403`, () => expect(blocked(sql)).toBe(true));

  const mustAllow: Array<[string, string]> = [
    ["A21 public table", "SELECT * FROM tags"],
    ["A22 name in string literal only", "SELECT * FROM tags WHERE name = 'notes'"],
    ["A23 similar name", "SELECT * FROM notes_archive"],
    ["A24 sqlite_master (schema only)", "SELECT name FROM sqlite_master"],
  ];
  for (const [name, sql] of mustAllow) it(`${name} → allowed`, () => expect(blocked(sql)).toBe(false));

  it("A25 no private tables declared → everything public still works", () => {
    expect(blocked("SELECT * FROM notes", new Set())).toBe(false);
  });
});

describe("A. Views over private tables", () => {
  const views = [
    { name: "v_notes", sql: "CREATE VIEW v_notes AS SELECT * FROM notes" },
    { name: "v2", sql: "CREATE VIEW v2 AS SELECT * FROM v_notes" },
    { name: "v_tags", sql: "CREATE VIEW v_tags AS SELECT * FROM tags" },
  ];
  const priv = privateTablesWithViews(PRIV, views);
  it("A26 direct view is private", () => expect(blocked("SELECT * FROM v_notes", priv)).toBe(true));
  it("A27 view of a view is private", () => expect(blocked("SELECT * FROM v2", priv)).toBe(true));
  it("A28 unrelated view stays public", () => expect(blocked("SELECT * FROM v_tags", priv)).toBe(false));
});

describe("C. validate_app / switch lint", () => {
  const lint = (files: Record<string, string>) =>
    checkMiniAppTableAcl(new Map(Object.entries(files)), PRIV).map((i) => `${i.rule}@${i.file}:${i.line}`);

  it("C1 frontend dbQuery flagged", () =>
    expect(lint({ "app.ts": "dbQuery(`SELECT * FROM notes`)" })).toEqual(["table-acl-frontend@app.ts:1"]));
  it("C2 fetch /api/db/query in a page flagged", () =>
    expect(lint({ "pages/a.ts": "fetch('/api/db/query',{body:JSON.stringify({sql:'SELECT * FROM notes'})})" }))
      .toHaveLength(1));
  it("C3 SQL in index.html flagged", () =>
    expect(lint({ "index.html": "<script>dbQuery('SELECT * FROM notes')</script>" })).toHaveLength(1));
  it("C4 dist/ ignored", () => expect(lint({ "dist/app.js": "SELECT * FROM notes" })).toEqual([]));
  it("C5 backend unfiltered read flagged", () =>
    expect(lint({ "backend/a.py": 'query(con, "SELECT * FROM notes")' })).toEqual(["table-acl-unfiltered@backend/a.py:1"]));
  it("C6 backend filtered read OK", () =>
    expect(lint({ "backend/a.py": 'w,a=acl_read_filter()\nquery(con, f"SELECT * FROM notes WHERE {w}", a)' })).toEqual([]));
  it("C7 `# acl: all-rows` opt-out OK", () =>
    expect(lint({ "backend/a.py": '# acl: all-rows\nquery(con, "SELECT * FROM notes")' })).toEqual([]));
  it("C8 public table in frontend not flagged", () =>
    expect(lint({ "app.ts": "dbQuery(`SELECT * FROM tags`)" })).toEqual([]));
  it("C9 backend unfiltered UPDATE flagged", () =>
    expect(lint({ "backend/a.py": 'write(con, "UPDATE notes SET body=?", [b])' })).toHaveLength(1));
});
