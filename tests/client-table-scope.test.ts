import { describe, expect, it } from "vitest";
import {
  clientDeniedError,
  deniedTableFromError,
  publicTablesFromSchema,
  tokenHasTablePermissions,
} from "../src/gateway/services/appRuntime/clientTableScope.js";

const schema = [
  { name: "tags", type: "table", sql: "CREATE TABLE tags(id)" },
  { name: "Notes", type: "table", sql: "CREATE TABLE Notes(id)" },
  { name: "v_tags", type: "view", sql: "CREATE VIEW v_tags AS SELECT * FROM tags" },
  { name: "pdocs", type: "table", sql: "CREATE VIRTUAL TABLE pdocs USING fts5(b)" },
  { name: "pdocs_content", type: "table", sql: "CREATE TABLE pdocs_content(id)" },
  { name: "_papr_oplog", type: "table", sql: "" },
  { name: "turso_cdc", type: "table", sql: "" },
  { name: "libsql_x", type: "table", sql: "" },
];

describe("client token table list", () => {
  it("lists public tables/views only; drops private (any case), FTS shadows, engine tables", () => {
    expect(publicTablesFromSchema(schema, new Set(["notes", "pdocs"]))).toEqual(["tags", "v_tags"]);
  });
  it("no private tables → every app table, still no engine tables", () => {
    expect(publicTablesFromSchema(schema, new Set())).toEqual(["Notes", "pdocs", "pdocs_content", "tags", "v_tags"]);
  });
});

describe("Turso refusals become plain 403s", () => {
  const priv = new Set(["notes"]);
  it("private table", () => {
    const d = deniedTableFromError(new Error("SQLITE_AUTH: SQLite error: access to notes.id is prohibited"));
    expect(d).toEqual({ denied: true, table: "notes" });
    const e = clientDeniedError(d.table, priv, "read") as Error & { status: number; code: string };
    expect([e.status, e.code]).toEqual([403, "table_private"]);
  });
  it("internal table", () => {
    const d = deniedTableFromError({ code: "SQLITE_AUTH", message: "access to _papr_oplog.id is prohibited" });
    expect((clientDeniedError(d.table, priv, "read") as Error & { code: string }).code).toBe("table_internal");
  });
  it("write blocked with no table named", () => {
    const d = deniedTableFromError(new Error("SQLITE_AUTH: not authorized"));
    expect(d.denied).toBe(true);
    expect((clientDeniedError(d.table, priv, "write") as Error & { status: number }).status).toBe(403);
  });
  it("ordinary errors pass through", () => {
    expect(deniedTableFromError(new Error("no such column: x")).denied).toBe(false);
  });
});

describe("fail closed on unscoped tokens", () => {
  const jwt = (p: object) => `h.${Buffer.from(JSON.stringify(p)).toString("base64url")}.s`;
  it("needs a perm claim", () => {
    expect(tokenHasTablePermissions(jwt({ a: "ro", perm: [{ t: ["tags"], a: ["data_read"] }] }))).toBe(true);
    expect(tokenHasTablePermissions(jwt({ a: "rw" }))).toBe(false);
    expect(tokenHasTablePermissions("garbage")).toBe(false);
  });
});

describe("message-only table guess for bare 'not authorized'", () => {
  it("names the private or internal table from the SQL", async () => {
    const { guessDeniedTable } = await import("../src/gateway/services/appRuntime/clientTableScope.js");
    expect(guessDeniedTable("SELECT count(*) FROM MEETING_NOTES", new Set(["meeting_notes"]))).toBe("MEETING_NOTES");
    expect(guessDeniedTable("SELECT count(*) FROM _papr_oplog", new Set())).toBe("_papr_oplog");
    expect(guessDeniedTable("SELECT 1", new Set(["x"]))).toBeUndefined();
  });
});
