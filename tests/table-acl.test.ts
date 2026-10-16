import { describe, expect, it } from "vitest";

import {
  assertRawSqlAllowed,
  assertNoSystemTables,
  isSystemTableName,
  getProtectedTables,
  invalidateProtectedTables,
  privateTablesWithViews,
} from "../src/gateway/services/appRuntime/tableAcl.js";
import {
  checkMiniAppTableAcl,
  summarizeTableAclIssues,
} from "../src/gateway/utils/miniAppTableAclLint.js";

describe("private table detection (declared, not inferred)", () => {
  const views = [
    { name: "v_notes", sql: "CREATE VIEW v_notes AS SELECT * FROM notes" },
    { name: "v_v_notes", sql: "CREATE VIEW v_v_notes AS SELECT * FROM v_notes" },
    { name: "v_tags", sql: "CREATE VIEW v_tags AS SELECT * FROM tags" },
  ];

  it("declared tables plus views over them (transitively); others stay public", () => {
    const t = privateTablesWithViews(new Set(["notes"]), views);
    expect([...t].sort()).toEqual(["notes", "v_notes", "v_v_notes"]);
  });

  it("nothing declared = nothing private, no schema load", async () => {
    let loads = 0;
    const t = await getProtectedTables("k", new Set(), async () => {
      loads += 1;
      return views;
    });
    expect(t.size).toBe(0);
    expect(loads).toBe(0);
  });

  it("an _owner column alone no longer makes a table private", () => {
    expect(privateTablesWithViews(new Set(), views).size).toBe(0);
  });

  it("caches per key + declared set and invalidates by prefix", async () => {
    let loads = 0;
    const load = async () => {
      loads += 1;
      return views;
    };
    await getProtectedTables("ns:slug:db", new Set(["notes"]), load);
    await getProtectedTables("ns:slug:db", new Set(["notes"]), load);
    expect(loads).toBe(1);
    await getProtectedTables("ns:slug:db", new Set(["notes", "tags"]), load);
    expect(loads).toBe(2);
    invalidateProtectedTables("ns:slug:");
    await getProtectedTables("ns:slug:db", new Set(["notes"]), load);
    expect(loads).toBe(3);
  });

  it("403 error carries code + table for the UI", () => {
    try {
      assertRawSqlAllowed("SELECT * FROM Notes", new Set(["notes"]));
      throw new Error("expected throw");
    } catch (e) {
      const err = e as { status?: number; code?: string; table?: string; message: string };
      expect(err.status).toBe(403);
      expect(err.code).toBe("table_private");
      expect(err.table).toBe("notes");
      expect(err.message).toMatch(/backend action/);
    }
  });
});

describe("assertRawSqlAllowed", () => {
  const protectedTables = new Set(["notes", "v_notes"]);
  const blocked = [
    "SELECT * FROM notes",
    'SELECT * FROM "Notes"',
    "SELECT * FROM [notes]",
    "SELECT * FROM main.notes",
    "SELECT t.tag FROM tags t JOIN notes n ON n.id = t.note_id",
    "SELECT tag FROM tags WHERE note_id IN (SELECT id FROM notes)",
    "WITH x AS (SELECT * FROM notes) SELECT * FROM x",
    "SELECT * FROM v_notes",
    "UPDATE notes SET body = 'x' WHERE id = 1",
    "DELETE FROM notes",
    "INSERT INTO notes(body) VALUES ('x')",
    "SELECT * FROM _papr_oplog",
    "SELECT count(*) FROM turso_cdc",
  ];
  for (const sql of blocked) {
    it(`blocks: ${sql}`, () => {
      expect(() => assertRawSqlAllowed(sql, protectedTables)).toThrow();
      try {
        assertRawSqlAllowed(sql, protectedTables);
      } catch (e) {
        expect((e as { status?: number }).status).toBe(403);
      }
    });
  }

  const allowed = [
    "SELECT * FROM tags",
    "SELECT * FROM tags WHERE tag = 'notes'",
    "SELECT * FROM tags -- notes",
    "SELECT name FROM sqlite_master",
    "INSERT INTO tags(tag) VALUES ('see _papr_oplog')",
  ];
  for (const sql of allowed) {
    it(`allows: ${sql}`, () => {
      expect(() => assertRawSqlAllowed(sql, protectedTables)).not.toThrow();
    });
  }

  it("leaves apps with no protected tables untouched", () => {
    expect(() => assertRawSqlAllowed("SELECT * FROM notes", new Set())).not.toThrow();
  });
});

describe("checkMiniAppTableAcl lint (private tables are errors)", () => {
  const priv = new Set(["notes"]);

  it("errors on backend action without an _acl filter", () => {
    const files = new Map([["backend/list.py", 'rows = query(con, "SELECT * FROM notes").rows']]);
    const issues = checkMiniAppTableAcl(files, priv);
    expect(issues.map((i) => [i.rule, i.severity, i.table, i.line])).toEqual([
      ["table-acl-unfiltered", "error", "notes", 1],
    ]);
  });

  it("passes backend action using acl_read_filter", () => {
    const files = new Map([
      ["backend/list.py", 'w, a = acl_read_filter()\nrows = query(con, f"SELECT * FROM notes WHERE {w}", a).rows'],
    ]);
    expect(checkMiniAppTableAcl(files, priv)).toEqual([]);
  });

  it("honours the explicit all-rows opt-out marker", () => {
    const files = new Map([
      ["backend/report.py", '# acl: all-rows  (admin report)\nrows = query(con, "SELECT count(*) FROM notes").rows'],
      ["backend/report.ts", '// acl: all-rows\nawait q("SELECT * FROM notes")'],
    ]);
    expect(checkMiniAppTableAcl(files, priv)).toEqual([]);
  });

  it("errors on every frontend call site with file:line", () => {
    const files = new Map([
      ["app.ts", "const a = 1;\nawait dbQuery(`SELECT * FROM notes`);\nawait dbWrite(`UPDATE notes SET x=1`);"],
    ]);
    const issues = checkMiniAppTableAcl(files, priv);
    expect(issues.map((i) => `${i.rule}@${i.file}:${i.line}`)).toEqual([
      "table-acl-frontend@app.ts:2",
      "table-acl-frontend@app.ts:3",
    ]);
    expect(summarizeTableAclIssues(issues)).toEqual([
      { table: "notes", rule: "table-acl-frontend", sites: ["app.ts:2", "app.ts:3"] },
    ]);
  });

  it("ignores dist/, schema files and unrelated tables / words", () => {
    const files = new Map([
      ["dist/app.js", "SELECT * FROM notes"],
      ["databases/x/migrations/0001.sql", "CREATE TABLE notes(id)"],
      ["app.ts", "SELECT * FROM notes_archive; // notes are great"],
    ]);
    expect(checkMiniAppTableAcl(files, priv)).toEqual([]);
  });

  it("is silent when no table is private (default)", () => {
    const files = new Map([["app.ts", "await dbQuery(`SELECT * FROM notes`)"]]);
    expect(checkMiniAppTableAcl(files, new Set())).toEqual([]);
  });
});

describe("internal tables are always blocked for non-owners", () => {
  const internal = [
    "SELECT * FROM _papr_oplog",
    "SELECT * FROM _PAPR_OPLOG",
    'SELECT * FROM "_papr_sync_log"',
    "SELECT * FROM main.turso_cdc",
    "SELECT * FROM turso_sync_state",
    "SELECT * FROM libsql_wasm_func_table",
    "SELECT * FROM __papr_migrations",
    "SELECT n.* FROM notes_public n JOIN _papr_oplog o ON o.row_id = n.id",
    "WITH c AS (SELECT * FROM turso_cdc) SELECT count(*) FROM c",
    "DELETE FROM _papr_oplog",
  ];
  for (const sql of internal) {
    it(`blocks even with no protected tables: ${sql}`, () => {
      expect(() => assertNoSystemTables(sql)).toThrow(/internal/);
      expect(() => assertRawSqlAllowed(sql, new Set())).toThrow(/internal/);
    });
  }
  const ok = [
    "SELECT name, sql FROM sqlite_master",
    "SELECT * FROM papr_notes",
    "SELECT * FROM notes WHERE body LIKE '%_papr_oplog%'",
  ];
  for (const sql of ok) {
    it(`allows: ${sql}`, () => {
      expect(() => assertNoSystemTables(sql)).not.toThrow();
    });
  }
  it("isSystemTableName", () => {
    expect(isSystemTableName("_papr_oplog")).toBe(true);
    expect(isSystemTableName("turso_cdc")).toBe(true);
    expect(isSystemTableName("meeting_notes")).toBe(false);
  });
});
