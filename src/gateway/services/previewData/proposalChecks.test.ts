import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildProposalChecks, describeStatement } from "./proposalChecks.js";
import { proposalPreviewDir } from "./proposalPreview.js";

describe("proposal checks (review sheet v2)", () => {
  let root: string;
  let teamDb: string;
  const read = async (sql: string) => {
    const db = new Database(teamDb, { readonly: true });
    try { return { rows: db.prepare(sql).all() as Record<string, unknown>[] }; } catch { return null; } finally { db.close(); }
  };
  const writeMig = (name: string, sql: string) => {
    const d = path.join(proposalPreviewDir("app", "r1", root), "code", "databases", "team", ["migr", "ations"].join(""));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, name), sql);
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "chk-"));
    teamDb = path.join(root, "team.db");
    const db = new Database(teamDb);
    db.exec("CREATE TABLE _papr_schema_migrations(id TEXT); INSERT INTO _papr_schema_migrations VALUES('0002_x');");
    db.exec("CREATE TABLE tasks(id INTEGER PRIMARY KEY, notes TEXT)");
    for (let i = 0; i < 50; i++) db.prepare("INSERT INTO tasks(notes) VALUES (?)").run(i < 42 ? `n${i}` : null);
    db.close();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("describes statements in plain words", async () => {
    expect((await describeStatement("ALTER TABLE tasks ADD COLUMN priority TEXT", read))?.text).toBe("Adds the priority field to tasks.");
    const drop = await describeStatement('ALTER TABLE "tasks" DROP COLUMN notes', read);
    expect(drop).toMatchObject({ text: "Removes the notes field from tasks.", lost: 42 });
    expect((await describeStatement("DROP TABLE tasks", read))?.lost).toBe(50);
  });

  it("code-only proposal: no confirm", async () => {
    const r = await buildProposalChecks({ appId: "app", requestId: "r1", paprRoot: root,
      databases: [{ label: "team", slug: "team", read, tryOnCopy: async () => {} }] });
    expect(r.confirm).toBeNull();
    expect(r.checks.map((c) => c.text)).toContain("No data change: only the app's code.");
  });

  it("adding a field never asks; old migrations aren't counted", async () => {
    writeMig("0001_old.sql", "DROP TABLE tasks;");
    writeMig("0003_add.sql", "ALTER TABLE tasks ADD COLUMN priority TEXT;");
    const r = await buildProposalChecks({ appId: "app", requestId: "r1", paprRoot: root,
      databases: [{ label: "team", slug: "team", read, tryOnCopy: async () => {} }] });
    expect(r.dataChange).toBe(true);
    expect(r.confirm).toBeNull();
    expect(r.checks.some((c) => c.text.includes("Adds the priority field"))).toBe(true);
  });

  it("removing data asks, with the count; a failure on the copy is red", async () => {
    writeMig("0003_drop.sql", "ALTER TABLE tasks DROP COLUMN notes;");
    const r = await buildProposalChecks({ appId: "app", requestId: "r1", paprRoot: root, needsUpdate: true,
      databases: [{ label: "team", slug: "team", read, tryOnCopy: async () => { throw new Error("x (no such column)"); } }] });
    expect(r.confirm).toBe("I understand the notes in 42 tasks rows will be deleted for everyone");
    expect(r.checks[0]!.text).toMatch(/^Needs update/);
    expect(r.checks.some((c) => c.tone === "bad" && c.text.startsWith("Fails on a test copy"))).toBe(true);
  });
});
