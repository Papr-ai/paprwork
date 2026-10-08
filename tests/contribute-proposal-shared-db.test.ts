/**
 * Proposals must not rewrite the publisher's database records or carry
 * migrations that never ran (2026-10-07 Customer Contacts PR shipped
 * data/databases.json naming the contributor's copy as schema owner, plus two
 * failed trigger migrations).
 */
import { createRequire } from "node:module";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const collaborator = { value: false };
vi.mock("../src/gateway/services/sharedPrimaryTursoResolve.js", async (orig) => ({
  ...(await orig<object>()),
  isCollaboratorOnSharedDatabase: () => collaborator.value,
}));

// better-sqlite3 is built for Electron and does not load under vitest; read the
// ledger with node:sqlite instead (same contract: rows, or null when unreadable).
vi.mock("../src/gateway/services/jobs/registryDbSchemaReader.js", async (orig) => ({
  ...(await orig<object>()),
  queryRegistryDatabase: async (input: { dbPath: string }, sql: string) => {
    const { createRequire: req } = await import("node:module");
    const { existsSync } = await import("node:fs");
    if (!existsSync(input.dbPath)) return null;
    const { DatabaseSync: Db } = req(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new Db(input.dbPath, { readOnly: true });
    try { return { rows: db.prepare(sql).all() as Record<string, unknown>[] }; } catch { return null; } finally { db.close(); }
  },
}));

import { mergeDatabasesJsonForContribute } from "../src/gateway/services/cloudSync/contributeDataIndexMerge.js";
import { dropUnappliedMigrations } from "../src/gateway/services/CloudAppContributeService.js";

// Vite cannot resolve node:sqlite as an ESM import; load it like install-scenario-matrix does.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const rec = (dbId: string, owner: string, extra: object = {}) => ({
  dbId, localPath: "/x/data.db", tursoShortName: `d-${dbId.slice(3)}`, isolation: "shared" as const,
  status: "active" as const, schemaOwnerAppId: owner, createdAt: "t", updatedAt: "t", ...extra,
});

describe("mergeDatabasesJsonForContribute", () => {
  it("never rewrites a database the publisher already has", () => {
    const owner = { version: 1 as const, databases: { "db-f3115d59": rec("db-f3115d59", "publisher") } };
    const contributor = {
      version: 1 as const,
      databases: { "db-f3115d59": rec("db-f3115d59", "copy", { syncMode: "replica" }) },
    };
    const merged = mergeDatabasesJsonForContribute(owner, contributor, ["db-f3115d59"], {
      forkAppId: "copy", targetAppId: "publisher",
    });
    expect(merged.databases["db-f3115d59"]).toEqual(owner.databases["db-f3115d59"]);
  });

  it("a new database is added, owned by the publisher's app, with no local path", () => {
    const owner = { version: 1 as const, databases: {} };
    const contributor = { version: 1 as const, databases: { "db-0000aaaa": rec("db-0000aaaa", "copy") } };
    const merged = mergeDatabasesJsonForContribute(owner, contributor, ["db-0000aaaa"], {
      forkAppId: "copy", targetAppId: "publisher",
    });
    expect(merged.databases["db-0000aaaa"]).toMatchObject({ schemaOwnerAppId: "publisher", localPath: "" });
  });
});

describe("dropUnappliedMigrations", () => {
  const dirs: string[] = [];
  afterEach(() => {
    collaborator.value = false;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  async function dbWithLedger(ids: string[]): Promise<string> {
    const dir = mkdtempSync(path.join(os.tmpdir(), "contrib-unapplied-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "data.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT)");
    for (const id of ids) db.prepare("INSERT INTO schema_migrations VALUES (?, 't')").run(id);
    db.close();
    return dbPath;
  }
  const files = () =>
    new Map([
      ["0006_purge.sql", "x"],
      ["0007_trigger_attempt.sql", "x"],
      ["0008_add_tables.sql", "x"],
      ["0009_trigger_retry.sql", "x"],
      ["snapshot.json", "{}"],
    ]);

  it("keeps applied migrations and other files, drops never-applied ones", async () => {
    const dbPath = await dbWithLedger(["0006_purge", "0008_add_tables.sql"]);
    const f = files();
    await dropUnappliedMigrations(f, "db-f3115d59", dbPath);
    expect([...f.keys()].sort()).toEqual(["0006_purge.sql", "0008_add_tables.sql", "snapshot.json"]);
  });

  it("unreadable ledger: leaves everything (unknown is not 'nothing applied')", async () => {
    const f = files();
    await dropUnappliedMigrations(f, "db-f3115d59", "/nonexistent/data.db");
    expect(f.size).toBe(5);
  });

  it("collaborator on shared data: proposed migrations are unapplied by design and stay", async () => {
    collaborator.value = true;
    const dbPath = await dbWithLedger(["0006_purge"]);
    const f = files();
    await dropUnappliedMigrations(f, "db-f3115d59", dbPath);
    expect(f.size).toBe(5);
  });
});
