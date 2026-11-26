import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeLiveCode } from "../liveCode/liveCodeCopy.js";
import { resolveLiveServe } from "../liveCode/liveCodeServe.js";
import {
  ensureProposalPreview,
  parseProposalPath,
  proposalDataSource,
  proposalFromReferer,
  removeProposalPreview,
} from "./proposalPreview.js";
import type { AppDataSource } from "../appDataSources.js";

const APP = "app-pr-1";
const PR = "req-123456";
const MIG = ["databases", "team", "migr" + "ations", "0002_note.sql"].join("/");

describe("Try a proposal (8d)", () => {
  let root: string;
  let teamDb: string;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "prpv-"));
    fs.mkdirSync(path.join(root, "apps", APP), { recursive: true });
    fs.writeFileSync(path.join(root, "apps", APP, "index.html"), "<p>MY UNPUBLISHED EDIT</p>");
    await writeLiveCode(APP, new Map([["index.html", "<p>live</p>"], ["a.css", "a{}"], ["old.css", "o{}"]]), root);
    teamDb = path.join(root, "team.db");
    const db = new Database(teamDb);
    db.exec("CREATE TABLE _papr_schema_migrations(id TEXT); INSERT INTO _papr_schema_migrations VALUES('0001_init');");
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)");
    for (let i = 0; i < 120; i++) db.prepare("INSERT INTO t(name) VALUES (?)").run(`r${i}`);
    db.close();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const files = (head = "sha1") => ({
    changed: new Map([
      ["index.html", "<p>proposal</p>"],
      [MIG, "ALTER TABLE t ADD COLUMN note TEXT;"],
    ]),
    removed: ["old.css"],
    headRef: head,
  });

  it("paths: @pr-<id>/… and the frame's referer name the proposal", () => {
    expect(parseProposalPath(`@pr-${PR}/dist/app.js`)).toEqual({ requestId: PR, rel: "dist/app.js" });
    expect(parseProposalPath(`@pr-${PR}`)).toEqual({ requestId: PR, rel: "index.html" });
    expect(parseProposalPath("@pr-../x")).toBeNull();
    expect(proposalFromReferer(`http://h/apps/${APP}/@pr-${PR}/index.html`)).toBe(PR);
    expect(proposalFromReferer(`http://h/apps/${APP}/index.html?pv=1`)).toBeNull();
  });

  it("code = Live + only the proposal's files; never your edits", async () => {
    const dir = await ensureProposalPreview(APP, PR, { files: files(), paprRoot: root });
    expect(fs.readFileSync(path.join(dir, "index.html"), "utf8")).toBe("<p>proposal</p>");
    expect(fs.readFileSync(path.join(dir, "a.css"), "utf8")).toBe("a{}");
    expect(fs.existsSync(path.join(dir, "old.css"))).toBe(false);
    const serve = await resolveLiveServe(APP, `@pr-${PR}/a.css`, root);
    expect(serve.dir).toBe(dir);
    expect(await serve.resolve("../../../../apps/x")).toBeNull();
  });

  it("reuses the folder for the same version, rebuilds when the proposal moves", async () => {
    const dir = await ensureProposalPreview(APP, PR, { files: files("sha1"), paprRoot: root });
    fs.writeFileSync(path.join(dir, "marker"), "x");
    await ensureProposalPreview(APP, PR, { files: files("sha1"), paprRoot: root });
    expect(fs.existsSync(path.join(dir, "marker"))).toBe(true);
    await ensureProposalPreview(APP, PR, { files: files("sha2"), paprRoot: root });
    expect(fs.existsSync(path.join(dir, "marker"))).toBe(false);
  });

  it("data = test copy with the proposal's data change; the team's data is untouched", async () => {
    await ensureProposalPreview(APP, PR, { files: files(), paprRoot: root });
    const real: AppDataSource = { id: "s", type: "sqlite", dbId: "db1", alias: "team", dbPath: teamDb, tables: [], linkedAt: "" };
    const read = async (sql: string) => {
      const db = new Database(teamDb, { readonly: true });
      try { return { rows: db.prepare(sql).all() as Record<string, unknown>[] }; } catch { return null; } finally { db.close(); }
    };
    const pv = await proposalDataSource(APP, PR, real, { read, migrationSlug: "team", paprRoot: root });
    const copy = new Database(pv.dbPath);
    expect((copy.prepare("PRAGMA table_info(t)").all() as Array<{ name: string }>).map((c) => c.name)).toContain("note");
    expect(copy.prepare("SELECT count(*) n FROM t").get()).toEqual({ n: 100 });
    copy.close();
    const team = new Database(teamDb, { readonly: true });
    expect((team.prepare("PRAGMA table_info(t)").all() as Array<{ name: string }>).map((c) => c.name)).not.toContain("note");
    team.close();
    await removeProposalPreview(APP, PR, root);
    expect(fs.existsSync(pv.dbPath)).toBe(false);
  });
});
