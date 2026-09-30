/**
 * Safe migrations: one migration = one transaction, and every statement is
 * checked against the live schema first ("already done?"), independent of the
 * ledger.
 *
 * Replays the LinkedIn Outreach fork failure: 0002 is
 *   ALTER TABLE replies RENAME COLUMN prospect_id TO member_id
 * and on a fork whose database already had `member_id` (ledger said "not
 * applied") the rename failed with "no such column: prospect_id" and left the
 * database half-migrated.
 *
 * Covered backends:
 *  - better-sqlite3 local runner (applyDatabaseMigrations)
 *  - Turso primary over @libsql/client (applyAndRecordMigrationOnTursoPrimary)
 *  - replica engine (@tursodatabase/sync) transaction used by the sync worker
 */
import { createClient, type Client } from "@libsql/client";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyDatabaseMigrations } from "../src/gateway/services/jobs/databaseMigrations.js";
import { applyAndRecordMigrationOnTursoPrimary } from "../src/gateway/services/jobs/jobMigrationTursoSync.js";
import {
  guardStatement,
  parseRenameColumnStatement,
  type SchemaInspector,
} from "../src/gateway/services/jobs/migrationStatementGuard.js";

let canUseBetterSqlite = false;
try {
  new Database(":memory:").close();
  canUseBetterSqlite = true;
} catch {
  canUseBetterSqlite = false;
}

const RENAME_0002 = "ALTER TABLE replies RENAME COLUMN prospect_id TO member_id;";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "papr-atomic-mig-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeMigrations(root: string, files: Record<string, string>): void {
  const dir = path.join(root, "migrations");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, sql] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), sql);
  }
}

function fakeSchema(tables: Record<string, string[]>, indexes: string[] = []): SchemaInspector {
  return {
    async objectExists(type, name) {
      if (type === "table") return name in tables;
      if (type === "index") return indexes.includes(name);
      return false;
    },
    async columnExists(table, column) {
      return (tables[table] ?? []).includes(column);
    },
  };
}

describe("migrationStatementGuard", () => {
  it("parses RENAME COLUMN with and without the COLUMN keyword and quoting", () => {
    expect(parseRenameColumnStatement(RENAME_0002)).toEqual({
      table: "replies",
      from: "prospect_id",
      to: "member_id",
    });
    expect(parseRenameColumnStatement('ALTER TABLE "r" RENAME "a" TO "b"')).toEqual({
      table: "r",
      from: "a",
      to: "b",
    });
  });

  it("skips a rename that already happened, runs one that has not", async () => {
    const done = fakeSchema({ replies: ["id", "member_id"] });
    const pending = fakeSchema({ replies: ["id", "prospect_id"] });
    expect((await guardStatement(RENAME_0002, done)).action).toBe("skip");
    expect((await guardStatement(RENAME_0002, pending)).action).toBe("run");
  });

  it("never skips a rename when BOTH columns exist (ambiguous — let it fail loudly)", async () => {
    const both = fakeSchema({ replies: ["id", "prospect_id", "member_id"] });
    expect((await guardStatement(RENAME_0002, both)).action).toBe("run");
  });

  it("skips DROP INDEX / DROP TABLE / DROP COLUMN when the object is already gone", async () => {
    const schema = fakeSchema({ people: ["id", "url"] }, []);
    expect((await guardStatement("DROP INDEX idx_people_url", schema)).action).toBe("skip");
    expect((await guardStatement("DROP TABLE old_things", schema)).action).toBe("skip");
    expect((await guardStatement("ALTER TABLE people DROP COLUMN legacy", schema)).action).toBe("skip");
    expect((await guardStatement("ALTER TABLE people DROP COLUMN url", schema)).action).toBe("run");
  });

  it("skips plain CREATE TABLE / CREATE INDEX when the object exists", async () => {
    const schema = fakeSchema({ people: ["id"] }, ["idx_people_id"]);
    expect((await guardStatement("CREATE TABLE people (id TEXT)", schema)).action).toBe("skip");
    expect((await guardStatement("CREATE INDEX idx_people_id ON people(id)", schema)).action).toBe("skip");
    expect((await guardStatement("CREATE TABLE other (id TEXT)", schema)).action).toBe("run");
  });

  it("strips BEGIN/COMMIT inside a migration file (we already run in one transaction)", async () => {
    const schema = fakeSchema({});
    expect((await guardStatement("BEGIN TRANSACTION", schema)).action).toBe("skip");
    expect((await guardStatement("COMMIT", schema)).action).toBe("skip");
  });

  it("always runs data statements (INSERT/UPDATE) — they are not schema-checkable", async () => {
    const schema = fakeSchema({ settings: ["id"] });
    expect(
      (await guardStatement("INSERT OR IGNORE INTO settings (id) VALUES ('singleton')", schema)).action,
    ).toBe("run");
  });
});

describe.skipIf(!canUseBetterSqlite)("local runner (better-sqlite3)", () => {
  function columns(dbPath: string, table: string): string[] {
    const db = new Database(dbPath, { readonly: true });
    try {
      return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
    } finally {
      db.close();
    }
  }
  function ledger(dbPath: string): string[] {
    const db = new Database(dbPath, { readonly: true });
    try {
      return (db.prepare("SELECT id FROM schema_migrations WHERE id <> '0001_baseline' ORDER BY id").all() as Array<{ id: string }>).map(
        (r) => r.id,
      );
    } finally {
      db.close();
    }
  }

  it("LinkedIn Outreach replay: 0002 rename on a DB that already has member_id succeeds", async () => {
    const root = path.join(tmp, "registry");
    writeMigrations(root, {
      "0001_init.sql": "CREATE TABLE IF NOT EXISTS replies (id TEXT PRIMARY KEY, member_id TEXT);",
      "0002_rename.sql": RENAME_0002,
    });
    const dbPath = path.join(root, "data.db");

    const applied = await applyDatabaseMigrations(root, dbPath);
    expect(applied).toEqual(["0001_init.sql", "0002_rename.sql"]);
    expect(columns(dbPath, "replies")).toEqual(["id", "member_id"]);
    expect(ledger(dbPath)).toEqual(["0001_init.sql", "0002_rename.sql"]);
  });

  it("a failing migration rolls back completely — no half-applied statements, no ledger row", async () => {
    const root = path.join(tmp, "registry");
    writeMigrations(root, {
      "0001_init.sql": "CREATE TABLE replies (id TEXT PRIMARY KEY, prospect_id TEXT);",
      "0002_bad.sql": `${RENAME_0002}\nALTER TABLE replies ADD COLUMN note TEXT;\nCREATE INDEX idx_x ON missing_table(a);`,
    });
    const dbPath = path.join(root, "data.db");

    await expect(applyDatabaseMigrations(root, dbPath)).rejects.toThrow(/missing_table/);
    expect(columns(dbPath, "replies")).toEqual(["id", "prospect_id"]);
    expect(ledger(dbPath)).toEqual(["0001_init.sql"]);

    // Fix the file and re-run: applies cleanly from the rolled-back state.
    writeMigrations(root, {
      "0002_bad.sql": `${RENAME_0002}\nALTER TABLE replies ADD COLUMN note TEXT;`,
    });
    expect(await applyDatabaseMigrations(root, dbPath)).toEqual(["0002_bad.sql"]);
    expect(columns(dbPath, "replies")).toEqual(["id", "member_id", "note"]);
  });

  it("re-running an unrecorded destructive migration after it already took effect is a no-op", async () => {
    const root = path.join(tmp, "registry");
    writeMigrations(root, {
      "0001_init.sql": "CREATE TABLE people (id TEXT PRIMARY KEY, url TEXT);\nCREATE UNIQUE INDEX idx_people_url ON people(url);",
      "0002_drop.sql": "DROP INDEX idx_people_url;\nALTER TABLE people DROP COLUMN url;",
    });
    const dbPath = path.join(root, "data.db");
    await applyDatabaseMigrations(root, dbPath);

    // Simulate the two-ledger bug: ledger loses 0002 but the schema has it.
    const db = new Database(dbPath);
    db.prepare("DELETE FROM schema_migrations WHERE id = '0002_drop.sql'").run();
    db.close();

    expect(await applyDatabaseMigrations(root, dbPath)).toEqual(["0002_drop.sql"]);
    expect(columns(dbPath, "people")).toEqual(["id"]);
  });
});

describe("Turso primary (@libsql/client, cloud-direct path)", () => {
  let client: Client;
  let root: string;
  beforeEach(() => {
    root = path.join(tmp, "registry");
    client = createClient({ url: `file:${path.join(tmp, "remote.db")}` });
  });
  afterEach(() => client.close());

  async function remoteColumns(table: string): Promise<string[]> {
    const r = await client.execute(`SELECT name FROM pragma_table_info('${table}')`);
    return r.rows.map((row) => String(row.name));
  }
  async function remoteLedger(): Promise<string[]> {
    const r = await client.execute("SELECT id FROM _papr_schema_migrations ORDER BY id");
    return r.rows.map((row) => String(row.id));
  }

  it("rename already applied + ledger missing → skipped, ledger recorded", async () => {
    await client.execute("CREATE TABLE replies (id TEXT PRIMARY KEY, member_id TEXT)");
    writeMigrations(root, { "0002_rename.sql": RENAME_0002 });

    await expect(applyAndRecordMigrationOnTursoPrimary(client, root, "0002_rename")).resolves.toEqual({
      applied: true,
    });
    expect(await remoteColumns("replies")).toEqual(["id", "member_id"]);
    expect(await remoteLedger()).toEqual(["0002_rename"]);
  });

  it("failure mid-migration rolls back the statements AND the ledger row", async () => {
    await client.execute("CREATE TABLE replies (id TEXT PRIMARY KEY, prospect_id TEXT)");
    writeMigrations(root, {
      "0002_bad.sql": `${RENAME_0002}\nCREATE INDEX idx_x ON missing_table(a);`,
    });

    await expect(applyAndRecordMigrationOnTursoPrimary(client, root, "0002_bad")).rejects.toThrow(
      /rolled back/,
    );
    expect(await remoteColumns("replies")).toEqual(["id", "prospect_id"]);
    expect(await remoteLedger()).toEqual([]);
  });
});

// The replica engine is the one the sync worker hosts. Exercise the exact
// transaction helper it uses, against a real @tursodatabase/sync handle
// (local-only file, no remote needed).
let syncConnect: ((opts: { path: string }) => Promise<unknown>) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  syncConnect = (await import("@tursodatabase/sync")).connect as typeof syncConnect;
} catch {
  syncConnect = null;
}

describe.skipIf(!syncConnect)("replica engine transaction (@tursodatabase/sync)", () => {
  it("guards the rename, rolls back on failure, commits statements + ledger together", async () => {
    const { runMigrationTransaction } = await import(
      "../src/gateway/services/tursoReplica/tursoReplicaSyncWorkerCore.js"
    );
    type Db = Parameters<typeof runMigrationTransaction>[0];
    const db = (await syncConnect!({ path: path.join(tmp, "replica.db") })) as Db & {
      exec(sql: string): Promise<void>;
      prepare(sql: string): Promise<{ all(): Promise<Array<Record<string, unknown>>> }>;
      close(): Promise<void>;
    };
    const cols = async () =>
      (await (await db.prepare("SELECT name FROM pragma_table_info('replies')")).all()).map((r) => r.name);
    const ledgerRows = async () =>
      (await (await db.prepare("SELECT id FROM schema_migrations")).all()).map((r) => r.id);
    const ledger = [
      { sql: "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)" },
      {
        sql: "INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))",
        params: ["0002_rename"],
      },
    ];
    const base = { id: "t", localPath: "x", tursoUrl: "", authToken: "", bootstrapIfEmpty: false } as const;

    await db.exec("CREATE TABLE replies (id TEXT PRIMARY KEY, prospect_id TEXT)");

    // 1. Failure rolls back the rename too.
    await expect(
      runMigrationTransaction(db, {
        ...base,
        op: "migrate",
        statements: [{ sql: RENAME_0002 }, { sql: "CREATE INDEX idx_x ON missing_table(a)" }],
        ledger,
      }),
    ).rejects.toThrow(/rolled back/);
    expect(await cols()).toEqual(["id", "prospect_id"]);

    // 2. Clean apply commits rename + ledger atomically.
    const ok = await runMigrationTransaction(db, {
      ...base,
      op: "migrate",
      statements: [{ sql: RENAME_0002 }],
      ledger,
    });
    expect(ok.executed).toHaveLength(1);
    expect(await cols()).toEqual(["id", "member_id"]);
    expect(await ledgerRows()).toEqual(["0002_rename"]);

    // 3. Re-run (ledger lost, schema has it) is a guarded no-op.
    const again = await runMigrationTransaction(db, {
      ...base,
      op: "migrate",
      statements: [{ sql: RENAME_0002 }],
      ledger,
    });
    expect(again.executed).toEqual([]);
    expect(again.skipped[0]?.reason).toMatch(/already renamed/);
    await db.close();
  });
});
