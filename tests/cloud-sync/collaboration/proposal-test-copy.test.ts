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

describe("sample row values from the replica", () => {
  it("binds blobs, booleans and objects the replica may return", async () => {
    const read: ReadQuery = async (sql) =>
      sql.startsWith("SELECT type")
        ? { rows: [{ type: "table", name: "t", sql: "CREATE TABLE t (a BLOB, b INTEGER, c TEXT)" }] }
        : { rows: [{ a: new Uint8Array([1, 2]).buffer, b: true, c: { k: 1 } }] };
    const r = await testMigrationsOnTestCopy(read, [{ id: "0002", sql: "CREATE INDEX t_b ON t(b);" }]);
    expect(r).toEqual({ passed: ["0002"] });
  });
});

describe("pending migrations on the team's data (contributor)", () => {
  it("tests files missing from the ledger, records them; an edited file is no longer tested", async () => {
    const { testPendingMigrations, testedMigrationIds } = await import(
      "../../../src/gateway/services/cloudSync/proposalTestCopy.js"
    );
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "papr-home-"));
    dirs.push(home);
    process.env.PAPR_HOME = home;
    const { file, read } = await realCopy(3);
    const w = new Database(file);
    w.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY); INSERT INTO schema_migrations VALUES ('0001_init');");
    w.close();
    const root = path.join(home, "data", "databases", "team");
    await fs.mkdir(path.join(root, "migrations"), { recursive: true });
    await fs.writeFile(path.join(root, "migrations", "0001_init.sql"), "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);");
    await fs.writeFile(path.join(root, "migrations", "0002_add.sql"), "ALTER TABLE notes ADD COLUMN p TEXT;");
    const r = await testPendingMigrations({ dbId: "db-1", migrationRoot: root, read });
    expect(r.pending).toEqual(["0002_add"]);
    expect(r.passed).toEqual(["0002_add"]);
    expect(cols(file)).toEqual(["id", "body"]);
    expect([...(await testedMigrationIds("db-1", root))]).toEqual(["0002_add"]);
    await fs.writeFile(path.join(root, "migrations", "0002_add.sql"), "ALTER TABLE notes ADD COLUMN q TEXT;");
    expect([...(await testedMigrationIds("db-1", root))]).toEqual([]);
    delete process.env.PAPR_HOME;
  });
});
