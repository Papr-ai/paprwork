/** Plan step 4: a proposal's migrations are tried on a test copy, never on the real one. */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

import { testMigrationsOnTestCopy, type ReadQuery } from "../../../src/gateway/services/cloudSync/proposalTestCopy.js";

const dirs: string[] = [];
async function realCopy(rows: number, dupes = false): Promise<{ file: string; read: ReadQuery }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "papr-real-"));
  dirs.push(dir);
  const file = path.join(dir, "data.db");
  const db = new Database(file);
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT); CREATE INDEX notes_body ON notes(body);");
  const ins = db.prepare("INSERT INTO notes (body) VALUES (?)");
  for (let i = 0; i < rows; i++) ins.run(dupes && i < 2 ? "dup" : `n${i}`);
  db.close();
  const read: ReadQuery = async (sql) => {
    const r = new Database(file, { readonly: true });
    try { return { rows: r.prepare(sql).all() as Record<string, unknown>[] }; } finally { r.close(); }
  };
  return { file, read };
}
const cols = (file: string) => {
  const db = new Database(file, { readonly: true });
  try { return (db.prepare("PRAGMA table_info(notes)").all() as { name: string }[]).map((c) => c.name); } finally { db.close(); }
};
afterEach(async () => { for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }); });

describe("proposal test copy", () => {
  it("runs the migrations on a copy; the real database is untouched", async () => {
    const { file, read } = await realCopy(5);
    const r = await testMigrationsOnTestCopy(read, [
      { id: "0002_add", sql: "ALTER TABLE notes ADD COLUMN priority TEXT;" },
      { id: "0003_idx", sql: "CREATE INDEX notes_priority ON notes(priority);" },
    ]);
    expect(r).toEqual({ passed: ["0002_add", "0003_idx"] });
    expect(cols(file)).toEqual(["id", "body"]);
  });

  it("stops at the first failure, against the sample rows", async () => {
    const { read } = await realCopy(5, true);
    const r = await testMigrationsOnTestCopy(read, [
      { id: "0002_ok", sql: "ALTER TABLE notes ADD COLUMN x TEXT;" },
      { id: "0003_uq", sql: "CREATE UNIQUE INDEX notes_uq ON notes(body);" },
      { id: "0004_never", sql: "ALTER TABLE notes ADD COLUMN y TEXT;" },
    ]);
    expect(r.passed).toEqual(["0002_ok"]);
    expect(r.failed?.id).toBe("0003_uq");
    expect(r.failed?.error).toMatch(/UNIQUE/);
  });

  it("copies at most 100 rows per table", async () => {
    const { read } = await realCopy(250);
    const r = await testMigrationsOnTestCopy(read, [
      { id: "0002_cap", sql: "CREATE TABLE c AS SELECT COUNT(*) AS n FROM notes; INSERT INTO c SELECT 1 WHERE (SELECT n FROM c) != 100;" },
      { id: "0003_check", sql: "CREATE UNIQUE INDEX c_one ON c(n);" },
    ]);
    expect(r).toEqual({ passed: ["0002_cap", "0003_check"] });
  });
});
