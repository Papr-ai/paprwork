/** A migration an older build filed under the wrong database is moved aside, nothing else is. */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, promises as fs } from "fs";
import os from "os";
import path from "path";

import {
  findMisfiledMigrations,
  quarantineMisfiledMigrations,
  type MigrationFolder,
} from "../../../src/gateway/services/jobs/misfiledMigrations.js";

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});

const NOTES = "0002_20261030160308_create_notes.sql";
const WP = "0002_20261124070827_init_workpapers.sql";
const NOTES_SQL = "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);\n";
const WP_SQL = "CREATE TABLE workpapers (id INTEGER PRIMARY KEY, title TEXT);\n";

async function setup(layout: Record<string, Record<string, string>>): Promise<MigrationFolder[]> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "papr-misfiled-"));
  roots.push(root);
  const out: MigrationFolder[] = [];
  for (const [slug, files] of Object.entries(layout)) {
    const dir = path.join(root, "data", "databases", slug, "migrations");
    await fs.mkdir(dir, { recursive: true });
    for (const [n, sql] of Object.entries(files)) await fs.writeFile(path.join(dir, n), sql);
    out.push({ dbId: `db-${slug}`, slug, dir });
  }
  return out;
}
const ledgers = (m: Record<string, string[]>) => async (f: MigrationFolder) =>
  new Set((m[f.slug] ?? []).map((x) => x.replace(/\.sql$/, "")));

describe("misfiled migrations", () => {
  it("the dev2 case: each database's migration in the other's folder, both moved aside", async () => {
    const folders = await setup({
      "team-data-680": { "0001_baseline.sql": "--\n", [NOTES]: NOTES_SQL, [WP]: WP_SQL },
      workpapers891: { "0001_baseline.sql": "--\n", [WP]: WP_SQL, [NOTES]: NOTES_SQL },
    });
    const read = ledgers({ "team-data-680": ["0001_baseline", NOTES], workpapers891: ["0001_baseline", WP] });
    const moved = await quarantineMisfiledMigrations(folders, read);
    expect(moved.map((m) => `${m.folder.slug}/${m.file}`).sort()).toEqual([`team-data-680/${WP}`, `workpapers891/${NOTES}`]);
    expect(existsSync(path.join(folders[0]!.dir, "_quarantine", WP))).toBe(true);
    expect(existsSync(path.join(folders[0]!.dir, NOTES))).toBe(true);
    expect(existsSync(path.join(folders[1]!.dir, WP))).toBe(true);
  });

  it("a new migration not applied anywhere yet is left alone", async () => {
    const f = "0023_20261126040000_e2e_priority.sql";
    const folders = await setup({ a: { [f]: "ALTER TABLE notes ADD COLUMN p TEXT;\n" }, b: {} });
    expect(await findMisfiledMigrations(folders, ledgers({}))).toEqual([]);
  });

  it("an applied migration is never moved, even if another folder has it", async () => {
    const folders = await setup({ a: { [NOTES]: NOTES_SQL }, b: { [NOTES]: NOTES_SQL } });
    expect(await findMisfiledMigrations(folders, ledgers({ a: [NOTES], b: [NOTES] }))).toEqual([]);
  });

  it("a fresh copy of the same database that hasn't run it yet is left alone", async () => {
    const folders = await setup({ notes: { [NOTES]: NOTES_SQL }, "notes-copy": { [NOTES]: NOTES_SQL } });
    expect(await findMisfiledMigrations(folders, ledgers({ notes: [NOTES], "notes-copy": [] }))).toEqual([]);
  });

  it("a diverged copy of the same database (shares early history) is left alone", async () => {
    const m1 = "0002_20261001000000_init.sql", m2 = "0003_20261002000000_next.sql", mine = "0004_20261003000000_local.sql";
    const folders = await setup({
      orig: { [m1]: "CREATE TABLE t (x);\n", [m2]: "ALTER TABLE t ADD COLUMN y;\n" },
      copy: { [m1]: "CREATE TABLE t (x);\n", [m2]: "ALTER TABLE t ADD COLUMN y;\n", [mine]: "SELECT 1;\n" },
    });
    expect(await findMisfiledMigrations(folders, ledgers({ orig: [m1, m2], copy: [m1, mine] }))).toEqual([]);
  });

  it("own-data copies ({slug}-{8hex}) are the same database", async () => {
    const other = "0003_20261101000000_other.sql";
    const folders = await setup({
      notes: { [NOTES]: NOTES_SQL },
      "notes-59e5ad02": { [NOTES]: NOTES_SQL, [other]: "SELECT 1;\n" },
    });
    expect(await findMisfiledMigrations(folders, ledgers({ notes: [NOTES], "notes-59e5ad02": [other] }))).toEqual([]);
  });

  it("same name, different SQL: not a copy, left alone", async () => {
    const folders = await setup({
      a: { [NOTES]: NOTES_SQL, "0005_20261101000000_a.sql": "SELECT 1;\n" },
      b: { [NOTES]: "CREATE TABLE other (x);\n" },
    });
    const read = ledgers({ a: ["0005_20261101000000_a"], b: [NOTES] });
    expect(await findMisfiledMigrations(folders, read)).toEqual([]);
  });

  it("baselines are never misfiled", async () => {
    const folders = await setup({ a: { "0001_baseline.sql": "--\n" }, b: { "0001_baseline.sql": "--\n" } });
    expect(await findMisfiledMigrations(folders, ledgers({ b: ["0001_baseline"] }))).toEqual([]);
  });

  it("an unreadable ledger: left alone", async () => {
    const folders = await setup({ a: { [NOTES]: NOTES_SQL }, b: { [NOTES]: NOTES_SQL } });
    expect(await findMisfiledMigrations(folders, async (f) => (f.slug === "a" ? null : new Set([NOTES.slice(0, -4)])))).toEqual([]);
  });
});
