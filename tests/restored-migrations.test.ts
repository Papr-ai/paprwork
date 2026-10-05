import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildProposalChangeSet } from "../src/gateway/services/cloudSync/contributeChangeSet.js";
import {
  appliedWithoutFile,
  checkSqlAgainstSchema,
  expectedSchemaFromSql,
  hashSql,
  readRestoredManifest,
  writeRestoredMigration,
} from "../src/gateway/services/jobs/restoredMigrations.js";

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("applied-without-file", () => {
  it("lists applied ids with no file, ignoring internal ledger rows", () => {
    expect(
      appliedWithoutFile(
        ["0001_baseline", "0025_report_comments", "0026_interviews", "__papr_x", "workspace_log"],
        ["0025_report_comments.sql"],
      ),
    ).toEqual(["0026_interviews"]);
  });
  it("treats id and id.sql as the same", () => {
    expect(appliedWithoutFile(["0002_a.sql"], ["0002_a.sql"])).toEqual([]);
  });
});

describe("schema check", () => {
  const sql = `CREATE TABLE IF NOT EXISTS interview_guides (id TEXT);\nALTER TABLE client_calls ADD COLUMN domain_match INTEGER;`;
  it("extracts tables and added columns", () => {
    expect(expectedSchemaFromSql(sql)).toEqual([
      { table: "interview_guides" },
      { table: "client_calls", column: "domain_match" },
    ]);
  });
  it("passes when live schema has them, reports what is missing otherwise", () => {
    const live = new Map([
      ["interview_guides", new Set(["id"])],
      ["client_calls", new Set(["id", "domain_match"])],
    ]);
    expect(checkSqlAgainstSchema(sql, live)).toEqual({ missing: [], unverifiable: false });
    live.delete("interview_guides");
    expect(checkSqlAgainstSchema(sql, live).missing).toEqual(["interview_guides"]);
  });
  it("flags data-only SQL as unverifiable", () => {
    expect(checkSqlAgainstSchema("UPDATE t SET a = 1", new Map()).unverifiable).toBe(true);
  });
});

describe("writeRestoredMigration", () => {
  it("writes once, records provenance, never overwrites", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "restore-"));
    tmp.push(root);
    const sql = "CREATE TABLE a (id TEXT);\n";
    const out = await writeRestoredMigration({
      migrationRoot: root,
      migrationId: "0026_interviews",
      sql,
      source: "app-folder-copy",
    });
    expect(fs.readFileSync(out.fullPath, "utf8")).toBe(sql);
    const manifest = await readRestoredManifest(root);
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toMatchObject({ id: "0026_interviews", sha256: hashSql(sql), source: "app-folder-copy" });
    await expect(
      writeRestoredMigration({ migrationRoot: root, migrationId: "0026_interviews", sql: "x", source: "s" }),
    ).rejects.toThrow();
  });
});

describe("proposal change set: migrations", () => {
  const tree = (local: Record<string, string>, base: Record<string, string>, restoredIds?: string[]) => ({
    repoDir: "databases/gtm/migrations",
    kind: "migrations" as const,
    local: new Map(Object.entries(local)),
    base: new Map(Object.entries(base)),
    restoredIds: new Set(restoredIds ?? []),
  });

  it("never proposes edits to a migration the publisher already has", () => {
    const cs = buildProposalChangeSet([
      tree({ "0001_init.sql": "CREATE TABLE IF NOT EXISTS a (id TEXT);" }, { "0001_init.sql": "CREATE TABLE a (id TEXT);" }),
    ]);
    expect(cs.writes.size).toBe(0);
    expect(cs.immutableSkipped).toEqual(["databases/gtm/migrations/0001_init.sql"]);
  });

  it("labels a restored migration instead of calling it new", () => {
    const cs = buildProposalChangeSet([tree({ "0026_interviews.sql": "CREATE TABLE b (id TEXT);" }, {}, ["0026_interviews"])]);
    expect(cs.restored).toEqual(["databases/gtm/migrations/0026_interviews.sql"]);
    expect(cs.writes.has("databases/gtm/migrations/0026_interviews.sql")).toBe(true);
  });

  it("a genuinely new migration is a plain write, not restored", () => {
    const cs = buildProposalChangeSet([tree({ "0030_20261005_add_x.sql": "ALTER TABLE a ADD COLUMN x TEXT;" }, {})]);
    expect(cs.restored).toEqual([]);
    expect(cs.writes.size).toBe(1);
  });
});
