/**
 * Items 5-6: schema snapshot at publish + {{papr.owner_user_id}}.
 */
import { createClient } from "@libsql/client";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  setMigrationOwnerResolverForTests,
  substituteMigrationPlaceholders,
} from "../src/gateway/services/jobs/migrationPlaceholders.js";
import {
  buildSchemaSnapshot,
  readSchemaSnapshot,
  schemaStatementsFromRows,
  sha256Of,
  validateSchemaSnapshot,
  writeSchemaSnapshot,
} from "../src/gateway/services/jobs/schemaSnapshot.js";
import { applyDatabaseMigrations } from "../src/gateway/services/jobs/databaseMigrations.js";
import { applySnapshotToRemoteIfFresh } from "../src/gateway/services/cloudDirect/cloudDirectMigrations.js";

let canUseBetterSqlite = false;
try {
  new Database(":memory:").close();
  canUseBetterSqlite = true;
} catch {
  canUseBetterSqlite = false;
}

const M1 = "CREATE TABLE replies (id INTEGER PRIMARY KEY, prospect_id TEXT, owner_id TEXT);";
const M2 = "ALTER TABLE replies RENAME COLUMN prospect_id TO member_id;";
const M3 = "CREATE INDEX idx_replies_owner ON replies(owner_id);";

let tmp: string;
let root: string;

function writeMigrations(files: Record<string, string>): void {
  fs.mkdirSync(path.join(root, "migrations"), { recursive: true });
  for (const [name, sql] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, "migrations", name), sql);
  }
}

/** Publisher side: real DB with migrations applied, then snapshot it. */
async function publishSnapshot(appliedFiles: string[]): Promise<void> {
  const pub = createClient({ url: ":memory:" });
  for (const f of appliedFiles) {
    await pub.executeMultiple(fs.readFileSync(path.join(root, "migrations", f), "utf8"));
  }
  await pub.execute("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT)");
  const res = await pub.execute(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid",
  );
  pub.close();
  const rows = res.rows.map((r) => ({
    type: String(r.type),
    name: String(r.name),
    tbl_name: String(r.tbl_name),
    sql: r.sql == null ? null : String(r.sql),
  }));
  const snapshot = await buildSchemaSnapshot({
    migrationRoot: root,
    schemaRows: rows,
    appliedLedgerIds: new Set(appliedFiles),
  });
  await writeSchemaSnapshot(root, snapshot);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "papr-snapshot-"));
  root = path.join(tmp, "data", "databases", "outreach");
  setMigrationOwnerResolverForTests(() => "installer-user");
});

afterEach(() => {
  setMigrationOwnerResolverForTests(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("owner placeholder", () => {
  it("fills {{papr.owner_user_id}} with the database owner, SQL-escaped", async () => {
    setMigrationOwnerResolverForTests(() => "o'brien");
    const out = await substituteMigrationPlaceholders(
      "INSERT INTO t (owner) VALUES ('{{papr.owner_user_id}}');",
      root,
    );
    expect(out).toBe("INSERT INTO t (owner) VALUES ('o''brien');");
  });

  it("refuses to run when a placeholder exists but no owner is known", async () => {
    setMigrationOwnerResolverForTests(() => undefined);
    await expect(
      substituteMigrationPlaceholders("SELECT '{{papr.owner_user_id}}'", root),
    ).rejects.toThrow(/no database owner/);
  });

  it("leaves SQL without placeholders untouched", async () => {
    setMigrationOwnerResolverForTests(() => undefined);
    expect(await substituteMigrationPlaceholders("SELECT 1", root)).toBe("SELECT 1");
  });
});

describe("snapshot build + validation", () => {
  it("orders tables before indexes and drops platform/engine objects", () => {
    const stmts = schemaStatementsFromRows([
      { type: "index", name: "idx_a", tbl_name: "a", sql: "CREATE INDEX idx_a ON a(x)" },
      { type: "table", name: "a", tbl_name: "a", sql: "CREATE TABLE a (x)" },
      { type: "table", name: "_papr_schema_migrations", sql: "CREATE TABLE _papr_schema_migrations (id)" },
      { type: "table", name: "turso_sync_last_change_id", sql: "CREATE TABLE turso_sync_last_change_id (x)" },
      { type: "table", name: "schema_migrations", sql: "CREATE TABLE schema_migrations (id)" },
    ]);
    expect(stmts).toEqual(["CREATE TABLE a (x)", "CREATE INDEX idx_a ON a(x)"]);
  });

  it("returns null when applied migrations have a gap (would lie about coverage)", async () => {
    writeMigrations({ "0001_init.sql": M1, "0002_rename.sql": M2, "0003_idx.sql": M3 });
    const snap = await buildSchemaSnapshot({
      migrationRoot: root,
      schemaRows: [{ type: "table", name: "replies", sql: "CREATE TABLE replies (id)" }],
      appliedLedgerIds: new Set(["0001_init.sql", "0003_idx"]),
    });
    expect(snap).toBeNull();
  });

  it("is invalidated when a covered migration file changes", async () => {
    writeMigrations({ "0001_init.sql": M1 });
    await publishSnapshot(["0001_init.sql"]);
    const snap = (await readSchemaSnapshot(root))!;
    expect((await validateSchemaSnapshot(root, snap)).ok).toBe(true);
    fs.writeFileSync(path.join(root, "migrations", "0001_init.sql"), M1 + "\n-- edited");
    expect((await validateSchemaSnapshot(root, snap)).ok).toBe(false);
  });

  it("republishing an unchanged schema does not rewrite the file", async () => {
    writeMigrations({ "0001_init.sql": M1 });
    await publishSnapshot(["0001_init.sql"]);
    const before = fs.statSync(path.join(root, "migrations", "snapshot.json")).mtimeMs;
    const changed = await writeSchemaSnapshot(root, {
      ...(await readSchemaSnapshot(root))!,
      generatedAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(changed).toBe(false);
    expect(fs.statSync(path.join(root, "migrations", "snapshot.json")).mtimeMs).toBe(before);
  });
});

describe.skipIf(!canUseBetterSqlite)("fresh install from snapshot (local runner)", () => {
  it("builds schema + seed from the snapshot, marks covered migrations, runs only newer ones", async () => {
    writeMigrations({ "0001_init.sql": M1, "0002_rename.sql": M2 });
    fs.writeFileSync(
      path.join(root, "seed.sql"),
      "INSERT INTO replies (member_id, owner_id) VALUES ('m1', '{{papr.owner_user_id}}');",
    );
    await publishSnapshot(["0001_init.sql", "0002_rename.sql"]);
    // Publisher later ships 0003, not in the snapshot.
    writeMigrations({ "0003_idx.sql": M3 });

    const dbPath = path.join(root, "data.db");
    const applied = await applyDatabaseMigrations(root, dbPath);
    expect(applied).toEqual(["0001_init.sql", "0002_rename.sql", "0003_idx.sql"]);

    const db = new Database(dbPath, { readonly: true });
    const cols = (db.prepare("PRAGMA table_info(replies)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("member_id");
    expect(cols).not.toContain("prospect_id");
    expect(db.prepare("SELECT owner_id FROM replies").get()).toEqual({ owner_id: "installer-user" });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='idx_replies_owner'").get(),
    ).toBeTruthy();
    db.close();

    // Re-run is a no-op.
    expect(await applyDatabaseMigrations(root, dbPath)).toEqual([]);
  });

  it("never applies a snapshot to a database that already has tables", async () => {
    writeMigrations({ "0001_init.sql": M1, "0002_rename.sql": M2 });
    await publishSnapshot(["0001_init.sql", "0002_rename.sql"]);
    const dbPath = path.join(root, "data.db");
    const existing = new Database(dbPath);
    existing.exec("CREATE TABLE user_notes (id INTEGER PRIMARY KEY)");
    existing.close();
    // No ledger → normal replay path; 0001 creates replies, 0002 renames.
    await applyDatabaseMigrations(root, dbPath);
    const db = new Database(dbPath, { readonly: true });
    const seed = db.prepare("SELECT COUNT(*) AS n FROM replies").get() as { n: number };
    expect(seed.n).toBe(0);
    db.close();
  });

  it("falls back to replay when a covered migration was edited", async () => {
    writeMigrations({ "0001_init.sql": M1 });
    await publishSnapshot(["0001_init.sql"]);
    fs.writeFileSync(
      path.join(root, "migrations", "0001_init.sql"),
      "CREATE TABLE replies (id INTEGER PRIMARY KEY, prospect_id TEXT, owner_id TEXT, extra TEXT);",
    );
    const dbPath = path.join(root, "data.db");
    await applyDatabaseMigrations(root, dbPath);
    const db = new Database(dbPath, { readonly: true });
    const cols = (db.prepare("PRAGMA table_info(replies)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("extra");
    db.close();
  });
});

describe("fresh install from snapshot (Turso primary / cloud-direct)", () => {
  it("one batch: schema + seed + _papr_schema_migrations rows; skipped when not fresh", async () => {
    writeMigrations({ "0001_init.sql": M1, "0002_rename.sql": M2 });
    fs.writeFileSync(
      path.join(root, "seed.sql"),
      "INSERT INTO replies (member_id, owner_id) VALUES ('m1', '{{papr.owner_user_id}}');",
    );
    await publishSnapshot(["0001_init.sql", "0002_rename.sql"]);
    const remote = createClient({ url: `file:${path.join(tmp, "primary.db")}` });
    try {
      expect(await applySnapshotToRemoteIfFresh(remote, root)).toEqual([
        "0001_init",
        "0002_rename",
      ]);
      const owner = await remote.execute("SELECT owner_id FROM replies");
      expect(owner.rows[0].owner_id).toBe("installer-user");
      const ledger = await remote.execute("SELECT id, source FROM _papr_schema_migrations ORDER BY id");
      expect(ledger.rows.map((r) => [r.id, r.source])).toEqual([
        ["0001_init", "schema_snapshot"],
        ["0002_rename", "schema_snapshot"],
      ]);
      // Second call: not fresh any more.
      expect(await applySnapshotToRemoteIfFresh(remote, root)).toEqual([]);
    } finally {
      remote.close();
    }
  });
});

describe("install setup prompt", () => {
  it("uses real workspace paths, names storage mode, and never hard-codes ~/Papr", async () => {
    const { buildCloudInstallAgentSetupMessage } = await import(
      "../src/gateway/services/cloudAppInstallBootstrap.js"
    );
    const { getPaprDataDir } = await import("../src/core/utils/paprRoot.js");
    const msg = buildCloudInstallAgentSetupMessage({
      appTitle: "LinkedIn Outreach",
      appId: "app-1",
      bootstrap: {
        appId: "app-1",
        linkedDbs: [
          {
            alias: "outreach",
            localPath: "/x/data.db",
            migrationsApplied: [],
            tursoPull: "skipped",
            userTableCount: 0,
            writable: false,
            warnings: [],
            errors: ["boom"],
          },
        ],
        ready: false,
        needsSeed: false,
        errors: ["boom"],
        warnings: [],
      },
    });
    expect(msg).not.toContain("~/Papr");
    expect(msg).toContain(getPaprDataDir());
    expect(msg).toContain("{{papr.owner_user_id}}");
    expect(msg).toContain("storage=local");
    expect(msg).toMatch(/Do not paste API keys/);
  });
});

describe("portableOwnerIdInSql (papr_db_create_migration)", () => {
  it("replaces only whole quoted literals of the owner's id", async () => {
    const { portableOwnerIdInSql } = await import(
      "../src/gateway/services/jobs/migrationPlaceholders.js"
    );
    const out = portableOwnerIdInSql(
      "UPDATE t SET owner_id = 'abc123XYZ' WHERE owner_id = 'abc123XYZ' OR note = 'abc123XYZ-suffix';",
      "abc123XYZ",
    );
    expect(out.replaced).toBe(2);
    expect(out.sql).toBe(
      "UPDATE t SET owner_id = '{{papr.owner_user_id}}' WHERE owner_id = '{{papr.owner_user_id}}' OR note = 'abc123XYZ-suffix';",
    );
  });

  it("is a no-op without an id, for short ids, or when the id is absent", async () => {
    const { portableOwnerIdInSql } = await import(
      "../src/gateway/services/jobs/migrationPlaceholders.js"
    );
    expect(portableOwnerIdInSql("SELECT 'x'", undefined).replaced).toBe(0);
    expect(portableOwnerIdInSql("SELECT 'abc'", "abc").replaced).toBe(0);
    expect(portableOwnerIdInSql("SELECT 1", "abc123XYZ").replaced).toBe(0);
  });

  it("round-trips: portable file fills back to the same id for the owner", async () => {
    const { portableOwnerIdInSql, substituteMigrationPlaceholders } = await import(
      "../src/gateway/services/jobs/migrationPlaceholders.js"
    );
    setMigrationOwnerResolverForTests(() => "abc123XYZ");
    const original = "INSERT INTO t (owner) VALUES ('abc123XYZ');";
    const portable = portableOwnerIdInSql(original, "abc123XYZ").sql;
    expect(await substituteMigrationPlaceholders(portable, root)).toBe(original);
  });
});

describe("snapshot carries migration seed rows", () => {
  const INIT =
    "CREATE TABLE settings (id TEXT PRIMARY KEY, owner TEXT);\n" +
    "CREATE TABLE stats (id TEXT PRIMARY KEY, n INTEGER DEFAULT 0);\n" +
    "INSERT OR IGNORE INTO settings (id, owner) VALUES ('singleton', '{{papr.owner_user_id}}');\n" +
    "INSERT OR IGNORE INTO stats (id) VALUES ('singleton');";

  it("installs schema + migration rows + seed.sql in order, for the installer", async () => {
    writeMigrations({ "0001_init.sql": INIT, "0002_col.sql": "ALTER TABLE stats ADD COLUMN day TEXT;" });
    fs.writeFileSync(path.join(root, "seed.sql"), "UPDATE stats SET n = 7 WHERE id = 'singleton';");
    await publishSnapshot(["0001_init.sql", "0002_col.sql"]);
    const snap = await readSchemaSnapshot(root);
    expect(snap?.migrations.map((m) => m.rows?.length)).toEqual([2, 0]);

    // Same plan every backend (local / replica / cloud-direct) executes.
    const { planSnapshotInstall } = await import(
      "../src/gateway/services/jobs/schemaSnapshotApply.js"
    );
    const plan = await planSnapshotInstall(root);
    expect(plan?.coveredFiles).toEqual(["0001_init.sql", "0002_col.sql"]);
    const db = createClient({ url: ":memory:" });
    for (const sql of plan!.statements) {
      await db.execute(sql);
    }
    expect((await db.execute("SELECT owner FROM settings")).rows[0].owner).toBe("installer-user");
    expect(Number((await db.execute("SELECT n FROM stats")).rows[0].n)).toBe(7); // seed.sql after rows
    db.close();
  });

  it("falls back (no snapshot) when a later migration reshapes a seeded table", async () => {
    writeMigrations({
      "0001_init.sql": INIT,
      "0002_rename.sql": "ALTER TABLE stats RENAME TO app_stats;",
    });
    await publishSnapshot(["0001_init.sql", "0002_rename.sql"]);
    expect(await readSchemaSnapshot(root)).toBeNull();
  });

  it("falls back on INSERT … SELECT from a seeded table (depends on replay-time data)", async () => {
    writeMigrations({
      "0001_init.sql": INIT,
      "0002_copy.sql": "CREATE TABLE s2 (id TEXT PRIMARY KEY); INSERT INTO s2 SELECT id FROM stats;",
    });
    await publishSnapshot(["0001_init.sql", "0002_copy.sql"]);
    expect(await readSchemaSnapshot(root)).toBeNull();
  });

  // SEO Audit 0002: copy-and-swap rebuild of an UNSEEDED table. On a fresh
  // install it moves zero rows, so the snapshot covers it with no row writes —
  // and installers never replay the DROP/RENAME that wedged the replica tape.
  it("covers a copy-and-swap rebuild of an unseeded table", async () => {
    writeMigrations({
      "0001_init.sql":
        "CREATE TABLE audits (id TEXT PRIMARY KEY, owner_session TEXT, created_at TEXT);\n" +
        "CREATE INDEX IF NOT EXISTS idx_audits_session ON audits(owner_session, created_at);",
      "0002_rebuild.sql":
        "CREATE TABLE audits_rebuild (id TEXT PRIMARY KEY, owner_session TEXT, created_at TEXT);\n" +
        "INSERT INTO audits_rebuild (id, owner_session, created_at) SELECT id, owner_session, created_at FROM audits;\n" +
        "DROP TABLE audits;\nALTER TABLE audits_rebuild RENAME TO audits;\n" +
        "CREATE INDEX IF NOT EXISTS idx_audits_session ON audits(owner_session, created_at);",
      "0003_user.sql": "ALTER TABLE audits ADD COLUMN user_id TEXT;",
    });
    await publishSnapshot(["0001_init.sql", "0002_rebuild.sql", "0003_user.sql"]);
    const snap = await readSchemaSnapshot(root);
    expect(snap?.migrations.map((m) => m.rows)).toEqual([[], [], []]);
    expect(snap?.schema.some((s) => /idx_audits_session/.test(s))).toBe(true);
  });

  // LinkedIn Outreach 0003-0005: `UPDATE people SET owner = '<publisher id>'`
  // backfills. On an empty table they are no-ops and must not be carried.
  it("drops backfill UPDATEs on unseeded tables (no publisher ids reach installers)", async () => {
    writeMigrations({
      "0001_init.sql": `${INIT}\nCREATE TABLE people (id TEXT PRIMARY KEY, owner TEXT);`,
      "0002_backfill.sql": "UPDATE people SET owner = 'PUBLISHER' WHERE owner IS NULL;",
      "0003_settings.sql": "UPDATE settings SET owner = 'PUBLISHER' WHERE owner IS NULL;",
    });
    await publishSnapshot(["0001_init.sql", "0002_backfill.sql", "0003_settings.sql"]);
    const snap = await readSchemaSnapshot(root);
    expect(snap?.migrations[1].rows).toEqual([]);
    // settings IS seeded by 0001, so its UPDATE is carried (same as replay).
    expect(snap?.migrations[2].rows?.map((r) => r.table)).toEqual(["settings"]);
  });

  it("ignores cached rows built under older extraction rules", async () => {
    writeMigrations({ "0001_init.sql": INIT });
    const stale = {
      formatVersion: 1 as const,
      generatedAt: "x",
      schema: [],
      migrations: [
        { file: "0001_init.sql", sha256: sha256Of(INIT), rows: [{ table: "stats", sql: "SELECT 'stale'" }] },
      ],
    };
    const next = await buildSchemaSnapshot({
      migrationRoot: root,
      schemaRows: [
        { type: "table", name: "settings", sql: "CREATE TABLE settings (id TEXT)" },
        { type: "table", name: "stats", sql: "CREATE TABLE stats (id TEXT)" },
      ],
      appliedLedgerIds: new Set(["0001_init.sql"]),
      previous: stale,
    });
    expect(next?.migrations[0].rows?.map((r) => r.table)).toEqual(["settings", "stats"]);
  });

  it("only parses migrations that are new or changed since the last snapshot", async () => {
    writeMigrations({ "0001_init.sql": INIT });
    await publishSnapshot(["0001_init.sql"]);
    const first = await readSchemaSnapshot(root);
    // Poison the cached rows: if 0001 were re-parsed, the real rows would come back.
    const poisoned = {
      ...first!,
      migrations: [{ ...first!.migrations[0], rows: [{ table: "stats", sql: "SELECT 'cached'" }] }],
    };
    writeMigrations({ "0002_col.sql": "ALTER TABLE stats ADD COLUMN day TEXT;" });
    const next = await buildSchemaSnapshot({
      migrationRoot: root,
      schemaRows: [
        { type: "table", name: "settings", sql: "CREATE TABLE settings (id TEXT)" },
        { type: "table", name: "stats", sql: "CREATE TABLE stats (id TEXT, day TEXT)" },
      ],
      appliedLedgerIds: new Set(["0001_init.sql", "0002_col.sql"]),
      previous: poisoned,
    });
    expect(next?.migrations[0].rows).toEqual([{ table: "stats", sql: "SELECT 'cached'" }]);
    expect(next?.migrations[1].rows).toEqual([]);

    // A changed 0001 (different sha) is re-parsed.
    writeMigrations({ "0001_init.sql": `${INIT}\n-- edited` });
    const reparsed = await buildSchemaSnapshot({
      migrationRoot: root,
      schemaRows: [
        { type: "table", name: "settings", sql: "CREATE TABLE settings (id TEXT)" },
        { type: "table", name: "stats", sql: "CREATE TABLE stats (id TEXT, day TEXT)" },
      ],
      appliedLedgerIds: new Set(["0001_init.sql", "0002_col.sql"]),
      previous: poisoned,
    });
    expect(reparsed?.migrations[0].rows?.map((r) => r.table)).toEqual(["settings", "stats"]);
  });
});

describe("migrationWritesRows (snapshot must not cover seeding migrations)", () => {
  it("flags INSERT/REPLACE, ignores DDL and trigger bodies and string data", async () => {
    const { migrationWritesRows } = await import(
      "../src/gateway/services/jobs/migrationSqlHelpers.js"
    );
    expect(migrationWritesRows("INSERT INTO t (a) VALUES (1);")).toBe(true);
    expect(migrationWritesRows("insert or ignore into t (a) values (1);")).toBe(true);
    expect(migrationWritesRows("REPLACE INTO t (a) VALUES (1);")).toBe(true);
    expect(migrationWritesRows("CREATE TABLE t (a TEXT); ALTER TABLE t ADD COLUMN b TEXT;")).toBe(false);
    expect(
      migrationWritesRows(
        "CREATE TRIGGER tr AFTER UPDATE ON t BEGIN INSERT INTO log (x) VALUES (1); END;",
      ),
    ).toBe(false);
    expect(migrationWritesRows("CREATE TABLE t (note TEXT DEFAULT 'insert into x');")).toBe(false);
  });
});

describe("engine-internal objects in published snapshots", () => {
  it("never snapshots or applies __turso_internal_* tables", async () => {
    const { isInternalSchemaObject } = await import(
      "../src/gateway/services/jobs/schemaSnapshot"
    );
    const { isInternalSchemaStatement } = await import(
      "../src/gateway/services/jobs/schemaSnapshotApply"
    );
    const name = "__turso_internal_seq___turso_internal_autoincrement_turso_cdc";
    expect(isInternalSchemaObject(name)).toBe(true);
    expect(
      isInternalSchemaStatement(`CREATE TABLE "${name}"(value INTEGER PRIMARY KEY)`),
    ).toBe(true);
    expect(isInternalSchemaStatement('CREATE TABLE "audits" (id TEXT)')).toBe(false);
    expect(
      isInternalSchemaStatement("CREATE INDEX idx_a ON audits(owner_session)"),
    ).toBe(false);
  });
});
