import { describe, expect, it } from "vitest";

import {
  checkMiniAppTableAcl,
  summarizeTableAclIssues,
} from "../../../src/gateway/utils/miniAppTableAclLint.js";

describe("checkMiniAppTableAcl lint (private tables are errors)", () => {
  const priv = new Set(["notes"]);

  it("errors on backend action without an _acl filter", () => {
    const files = new Map([["backend/list.py", 'rows = query(con, "SELECT * FROM notes").rows']]);
    const issues = checkMiniAppTableAcl(files, priv);
    expect(issues.map((i) => [i.rule, i.severity, i.table, i.line])).toEqual([
      ["table-acl-unfiltered", "error", "notes", 1],
    ]);
  });

  it("passes backend action scoped with :caller_id", () => {
    const files = new Map([["backend/list.py", 'query(con, "SELECT * FROM notes WHERE owner = :caller_id")']]);
    expect(checkMiniAppTableAcl(files, priv)).toEqual([]);
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
