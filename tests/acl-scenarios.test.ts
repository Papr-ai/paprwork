/**
 * Scenario matrix for private tables (test plan §C). Table access itself is
 * enforced by Turso (see client-table-scope.test.ts + the live probe).
 */
import { describe, expect, it } from "vitest";
import { checkMiniAppTableAcl } from "../src/gateway/utils/miniAppTableAclLint.js";

const PRIV = new Set(["notes"]);

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

describe("A. Engine write guard shares the scanner", () => {
  it("A29 comment trick can't write an engine table", async () => {
    const { findEngineOwnedTableReference } = await import(
      "../src/gateway/services/appRuntime/engineOwnedTables.js"
    );
    expect(findEngineOwnedTableReference("INSERT INTO/**/_papr_oplog VALUES(1)")).not.toBeNull();
  });
});
