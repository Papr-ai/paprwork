import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isPreviewRequest, previewSourceFor, resetPreviewDataForTests, type PreviewDeps } from "./previewDataCopy.js";
import type { AppDataSource } from "../appDataSources.js";

describe("Preview data test copy", () => {
  let root: string;
  let teamDb: string;
  let migRoot: string;
  const src = (): AppDataSource => ({ id: "s", type: "sqlite", dbId: "db1", alias: "main", dbPath: teamDb, tables: [], linkedAt: "" });
  const deps = (shared = true): PreviewDeps => ({
    isCollaboratorOnShared: () => shared,
    migrationRoot: () => migRoot,
    read: async (_s, sql) => {
      const db = new Database(teamDb, { readonly: true });
      try { return { rows: db.prepare(sql).all() as Record<string, unknown>[] }; } catch { return null; } finally { db.close(); }
    },
    paprRoot: root,
  });
  const addMigration = (name: string, sql: string) => fs.writeFileSync(path.join(migRoot, "migrations", name), sql);

  beforeEach(() => {
    resetPreviewDataForTests();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pv-"));
    migRoot = path.join(root, "db1");
    fs.mkdirSync(path.join(migRoot, "migrations"), { recursive: true });
    teamDb = path.join(migRoot, "data.db");
    const db = new Database(teamDb);
    db.exec("CREATE TABLE schema_migrations(id TEXT); INSERT INTO schema_migrations VALUES('0001_init');");
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT);");
    for (let i = 0; i < 150; i++) db.prepare("INSERT INTO t(name) VALUES (?)").run(`r${i}`);
    db.close();
    addMigration("0001_init.sql", "CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT);");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("only the Preview frame asks for it; Live never does", () => {
    expect(isPreviewRequest("http://localhost:1/apps/a/index.html?pv=1")).toBe(true);
    expect(isPreviewRequest("http://localhost:1/apps/a/@live/index.html?pv=1")).toBe(false);
    expect(isPreviewRequest("http://localhost:1/apps/a/index.html")).toBe(false);
    expect(isPreviewRequest(undefined)).toBe(false);
  });

  it("nothing pending, or not a teammate on shared data: the real database", async () => {
    expect(await previewSourceFor("app", src(), deps())).toBeNull();
    addMigration("0002_add.sql", "ALTER TABLE t ADD COLUMN note TEXT;");
    resetPreviewDataForTests();
    expect(await previewSourceFor("app", src(), deps(false))).toBeNull();
  });

  it("pending change: a test copy with the change and up to 100 rows; the team's data is untouched", async () => {
    addMigration("0002_add.sql", "ALTER TABLE t ADD COLUMN note TEXT;");
    const pv = await previewSourceFor("app", src(), deps());
    expect(pv?.previewCopy).toBe(true);
    expect(pv?.dbId).toBeUndefined();
    const copy = new Database(pv!.dbPath);
    expect(copy.prepare("SELECT count(*) n FROM t").get()).toEqual({ n: 100 });
    copy.prepare("INSERT INTO t(name, note) VALUES ('x','test')").run();
    copy.close();
    const team = new Database(teamDb, { readonly: true });
    expect((team.prepare("PRAGMA table_info(t)").all() as Array<{ name: string }>).map((c) => c.name)).toEqual(["id", "name"]);
    expect(team.prepare("SELECT count(*) n FROM t").get()).toEqual({ n: 150 });
    team.close();
  });

  it("reuses the copy while the change is the same; rebuilds when it changes; drops it when nothing is pending", async () => {
    addMigration("0002_add.sql", "ALTER TABLE t ADD COLUMN note TEXT;");
    const a = await previewSourceFor("app", src(), deps());
    resetPreviewDataForTests();
    expect((await previewSourceFor("app", src(), deps()))?.dbPath).toBe(a!.dbPath);
    addMigration("0003_more.sql", "ALTER TABLE t ADD COLUMN tag TEXT;");
    resetPreviewDataForTests();
    const b = await previewSourceFor("app", src(), deps());
    expect(b!.dbPath).not.toBe(a!.dbPath);
    expect(fs.existsSync(a!.dbPath)).toBe(false);
    fs.rmSync(path.join(migRoot, "migrations", "0002_add.sql"));
    fs.rmSync(path.join(migRoot, "migrations", "0003_more.sql"));
    resetPreviewDataForTests();
    expect(await previewSourceFor("app", src(), deps())).toBeNull();
    expect(fs.existsSync(b!.dbPath)).toBe(false);
  });

  it("an old unrecorded file isn't your change; only ones newer than the team's latest are", async () => {
    const db = new Database(teamDb);
    db.exec("CREATE TABLE _papr_schema_migrations(id TEXT); INSERT INTO _papr_schema_migrations VALUES('0005_x');");
    db.close();
    addMigration("0003_leftover.sql", "CREATE TABLE leftover(x);");
    expect(await previewSourceFor("app", src(), deps())).toBeNull();
    addMigration("0006_mine.sql", "ALTER TABLE t ADD COLUMN note TEXT;");
    resetPreviewDataForTests();
    expect((await previewSourceFor("app", src(), deps()))?.previewCopy).toBe(true);
  });

  it("a change that fails on the test copy: Preview shows the team's data", async () => {
    addMigration("0002_bad.sql", "ALTER TABLE nope ADD COLUMN x TEXT;");
    expect(await previewSourceFor("app", src(), deps())).toBeNull();
  });
});
