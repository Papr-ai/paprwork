/** Step 5: one migrations folder per database (C, E), job ledger check (G), edited-migration warning (I). */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProposalChangeSet } from "../../../src/gateway/services/cloudSync/contributeChangeSet.js";
import {
  appliedJobMigrationIds,
  assertProposalMigrationsApplied,
} from "../../../src/gateway/services/CloudAppContributeService.js";
import {
  hydrateAppFolderSchemaMigrationsToRegistry,
  mirrorSchemaMigrationToRegistry,
} from "../../../src/gateway/services/syncV3/syncPulledSchemaOwnerMigrations.js";

const APP = "dca047a9-e118-4798-b7ee-e346f474b4d9";
const MIG = "migrations";
let home = "";
const write = (rel: string, body: string) => {
  const p = path.join(home, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};
const registry = (owner: string) =>
  write("data/databases.json", JSON.stringify({ databases: {
    "db-4f9d137f": { dbId: "db-4f9d137f", status: "active", schemaOwnerAppId: owner,
      localPath: path.join(home, "data/databases/team-data-680/data.db") },
  } }));
const hydrate = (includeLinked?: boolean) =>
  hydrateAppFolderSchemaMigrationsToRegistry({ appId: APP, paprRoot: home, appsRoot: path.join(home, "apps"), includeLinked });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "one-mig-"));
  // Team Data 680's database is owned by the publisher's app id, not this copy.
  registry("e5ba032d-c560-4803-97f1-bc944c2046af");
  write(`apps/${APP}/data-sources.json`, JSON.stringify({ sources: [{ id: "a", type: "sqlite", dbId: "db-4f9d137f", alias: "notes" }] }));
  write(`apps/${APP}/databases/team-data-680/${MIG}/0007_tags.sql`, "ALTER TABLE notes ADD COLUMN tags TEXT;");
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("E: a copy that doesn't own the schema", () => {
  it("before: its app-folder migration never reached the real folder", async () => {
    expect((await hydrate()).copied).toEqual([]);
  });
  it("Propose mirrors it into the one real folder, so it is checked and tested", async () => {
    expect((await hydrate(true)).copied).toEqual([`data/databases/team-data-680/${MIG}/0007_tags.sql`]);
  });
});

it("C: a declined migration in _quarantine is not brought back from the app folder", async () => {
  write(`data/databases/team-data-680/${MIG}/_quarantine/0007_tags.sql.rejected`, "ALTER TABLE notes ADD COLUMN tags TEXT;");
  const r = await hydrate(true);
  expect(r.copied).toEqual([]);
  expect(r.skipped.join()).toMatch(/declined/);
  expect(fs.existsSync(path.join(home, `data/databases/team-data-680/${MIG}/0007_tags.sql`))).toBe(false);
});

describe("G: job migrations", () => {
  const tree = (appliedIds: Set<string> | null) => ({
    repoDir: `Jobs/j1/${MIG}`, kind: "migrations" as const, base: new Map<string, string>(),
    local: new Map([["0002_add.sql", "ALTER TABLE t ADD COLUMN x TEXT;"]]), appliedIds,
  });
  // Electron-built native driver in local dev; CI's Node build runs it.
  let canUseBetterSqlite = false;
  try {
    new Database(":memory:").close();
    canUseBetterSqlite = true;
  } catch {
    /* skip below */
  }
  it.skipIf(!canUseBetterSqlite)("reads the job's own ledger", async () => {
    const jobDir = path.join(home, "Jobs/j1");
    fs.mkdirSync(path.join(jobDir, "data"), { recursive: true });
    const db = new Database(path.join(jobDir, "data/data.db"));
    db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT); INSERT INTO schema_migrations VALUES ('0002_add.sql','x')");
    db.close();
    expect(await appliedJobMigrationIds(jobDir)).toEqual(new Set(["0002_add"]));
    expect(await appliedJobMigrationIds(path.join(home, "Jobs/none"))).toBeNull();
  });
  it("a job migration that never ran blocks the proposal with a job-specific message", () => {
    const changes = buildProposalChangeSet([tree(null)]);
    expect(changes.unverified).toEqual([`Jobs/j1/${MIG}/0002_add.sql`]);
    expect(() => assertProposalMigrationsApplied(changes)).toThrow(/Run the job once/);
  });
  it("one that ran is proposed", () => {
    const changes = buildProposalChangeSet([tree(new Set(["0002_add"]))]);
    expect(changes.unapplied).toEqual([]);
    expect(changes.unverified).toEqual([]);
  });
});

it("I: an applied migration edited upstream is kept and reported, not silently replaced", async () => {
  registry(APP);
  write(`data/databases/team-data-680/${MIG}/0005_x.sql`, "CREATE TABLE x (id INTEGER PRIMARY KEY);");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const out = await mirrorSchemaMigrationToRegistry({
    appId: APP, paprRoot: home, repoPath: `databases/team-data-680/${MIG}/0005_x.sql`,
    content: "CREATE TABLE x (id INTEGER PRIMARY KEY, extra TEXT);", lastSyncedOid: null,
  });
  expect(out).toEqual({ kind: "skipped", reason: "edited upstream after it shipped (kept local)" });
  expect(warn).toHaveBeenCalled();
  expect(fs.readFileSync(path.join(home, `data/databases/team-data-680/${MIG}/0005_x.sql`), "utf8")).toMatch(/PRIMARY KEY\)/);
});
