/**
 * App migrations must not own Papr platform tables (app_files, _papr_*, …).
 *
 * Replays the Scenario Community install failure: a "restore table keys"
 * repair migration rebuilt the app's tables AND app_files / app_file_hashes /
 * _papr_sync_meta / _papr_sync_mute. On the publisher those tables existed;
 * on a fresh install they did not, so
 *
 *   INSERT OR IGNORE INTO app_files__fix SELECT … FROM app_files
 *   -> "no such table: app_files"
 *
 * rolled the whole install back. The same migration also blocked the publish
 * snapshot (it seeds `_papr_sync_mute__fix` then renames it), which is why
 * installers were replaying history in the first place.
 */
import { createClient } from "@libsql/client";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyDatabaseMigrations } from "../../src/gateway/services/jobs/databaseMigrations.js";
import { applyAndRecordMigrationOnTursoPrimary } from "../../src/gateway/services/jobs/jobMigrationTursoSync.js";
import { guardStatement, type SchemaInspector } from "../../src/gateway/services/jobs/migrationStatementGuard.js";
import { splitSqlStatements } from "../../src/gateway/services/jobs/migrationSqlHelpers.js";
import {
  isPlatformOwnedTable,
  platformOwnedStatements,
  platformOwnedTarget,
} from "../../src/gateway/services/jobs/platformOwnedTables.js";
import { buildSchemaSnapshot } from "../../src/gateway/services/jobs/schemaSnapshot.js";

let canUseBetterSqlite = false;
try {
  new Database(":memory:").close();
  canUseBetterSqlite = true;
} catch {
  canUseBetterSqlite = false;
}

const INIT = `
CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, title TEXT);
CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, kind TEXT);
`;

/** Trimmed copy of Scenario 0005_restore_table_keys_and_defaults.sql. */
const REPAIR = `
-- Repair: rebuild each table to its declared schema, keeping every row.
CREATE TABLE videos__fix (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'Untitled');
INSERT OR IGNORE INTO videos__fix SELECT id, COALESCE(title,'Untitled') FROM videos WHERE id IS NOT NULL;
DROP TABLE videos;
ALTER TABLE videos__fix RENAME TO videos;

-- Platform App Files tables (same shape as appFilesSchema.ts).
CREATE TABLE app_files__fix (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, object_key TEXT NOT NULL);
INSERT OR IGNORE INTO app_files__fix SELECT id, app_id, object_key FROM app_files WHERE id IS NOT NULL;
DROP TABLE app_files;
ALTER TABLE app_files__fix RENAME TO app_files;
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_files_key ON app_files(object_key);

-- Platform sync bookkeeping.
CREATE TABLE _papr_sync_meta__fix (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO _papr_sync_meta__fix SELECT 1, COALESCE(MAX(CAST(version AS INTEGER)),0) FROM _papr_sync_meta;
DROP TABLE _papr_sync_meta;
ALTER TABLE _papr_sync_meta__fix RENAME TO _papr_sync_meta;
CREATE TABLE _papr_sync_mute__fix (id INTEGER PRIMARY KEY, depth INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO _papr_sync_mute__fix (id, depth) VALUES (1, 0);
DROP TABLE _papr_sync_mute;
ALTER TABLE _papr_sync_mute__fix RENAME TO _papr_sync_mute;
`;

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "papr-platform-tables-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function writeMigrations(root: string, files: Record<string, string>): void {
  const dir = path.join(root, "migrations");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, sql] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), sql);
  }
}

describe("platformOwnedTables", () => {
  it("recognises platform tables and their rebuild copies, not app tables", () => {
    for (const name of [
      "app_files",
      "APP_FILES",
      "app_file_hashes",
      "app_files__fix",
      "app_files__pk",
      "app_file_hashes_new",
      "_papr_sync_meta",
      "_papr_sync_mute__fix",
      "turso_cdc",
      "schema_migrations",
    ]) {
      expect(isPlatformOwnedTable(name), name).toBe(true);
    }
    for (const name of ["videos", "videos__fix", "app_filesystem", "my_app_files", "sqlite_sequence"]) {
      expect(isPlatformOwnedTable(name), name).toBe(false);
    }
  });

  it("targets what a statement writes, not what it reads", () => {
    expect(platformOwnedTarget("CREATE TABLE app_files__fix (id TEXT)")).toBe("app_files__fix");
    expect(platformOwnedTarget("DROP TABLE app_files")).toBe("app_files");
    expect(platformOwnedTarget("ALTER TABLE app_files__fix RENAME TO app_files")).toBe("app_files__fix");
    expect(platformOwnedTarget("CREATE UNIQUE INDEX IF NOT EXISTS i ON app_files(object_key)")).toBe("app_files");
    expect(platformOwnedTarget('INSERT OR IGNORE INTO "_papr_sync_mute__fix" (id) VALUES (1)')).toBe(
      "_papr_sync_mute__fix",
    );
    expect(platformOwnedTarget("-- header\nUPDATE _papr_sync_meta SET version = 0")).toBe("_papr_sync_meta");

    expect(platformOwnedTarget("INSERT INTO videos SELECT id, 'x' FROM app_files")).toBeNull();
    expect(platformOwnedTarget("CREATE INDEX idx_videos ON videos(id)")).toBeNull();
    expect(platformOwnedTarget("DELETE FROM sqlite_sequence WHERE name = 'videos'")).toBeNull();
  });

  it("lists the offending statements for the authoring error", () => {
    const hits = platformOwnedStatements(splitSqlStatements(REPAIR));
    const tables = new Set(hits.map((hit) => hit.table.toLowerCase()));
    expect(tables).toEqual(
      new Set(["app_files__fix", "app_files", "_papr_sync_meta__fix", "_papr_sync_meta", "_papr_sync_mute__fix", "_papr_sync_mute"]),
    );
    expect(hits.some((hit) => /videos/.test(hit.statement))).toBe(false);
  });

  it("the async statement guard skips platform-table statements", async () => {
    const empty: SchemaInspector = {
      objectExists: async () => false,
      columnExists: async () => false,
    };
    const decision = await guardStatement(
      "INSERT OR IGNORE INTO app_files__fix SELECT id FROM app_files",
      empty,
    );
    expect(decision.action).toBe("skip");
    expect((await guardStatement("INSERT INTO videos (id) VALUES ('a')", empty)).action).toBe("run");
  });
});

describe("schema snapshot", () => {
  it("still builds when a covered migration rebuilds platform tables", async () => {
    const root = path.join(tmp, "snap");
    writeMigrations(root, { "0001_init.sql": INIT, "0002_repair.sql": REPAIR });
    const snapshot = await buildSchemaSnapshot({
      migrationRoot: root,
      schemaRows: [
        { type: "table", name: "videos", tbl_name: "videos", sql: "CREATE TABLE videos (id TEXT PRIMARY KEY)" },
      ],
      appliedLedgerIds: new Set(["0001_init", "0002_repair"]),
      previous: null,
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot!.migrations.map((m) => m.file)).toEqual(["0001_init.sql", "0002_repair.sql"]);
    // The _papr_sync_mute seed is platform bookkeeping, never carried to installers.
    expect(snapshot!.migrations.flatMap((m) => m.rows ?? [])).toEqual([]);
  });
});

describe.skipIf(!canUseBetterSqlite)("fresh install replay (better-sqlite3)", () => {
  it("installs an app whose migration rebuilds app_files on a database that has none", async () => {
    const root = path.join(tmp, "registry");
    writeMigrations(root, { "0001_init.sql": INIT, "0002_repair.sql": REPAIR });
    const dbPath = path.join(root, "data.db");

    const applied = await applyDatabaseMigrations(root, dbPath);
    expect(applied).toEqual(["0001_init.sql", "0002_repair.sql"]);

    const db = new Database(dbPath, { readonly: true });
    try {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>).map((row) => row.name);
      expect(tables).toContain("videos");
      expect(tables).not.toContain("videos__fix");
      // Left for the platform to create with its current DDL on first use.
      expect(tables.some((name) => name.startsWith("app_files") || name.startsWith("_papr_sync_m"))).toBe(false);
      const titleCol = (db.prepare("PRAGMA table_info(videos)").all() as Array<{ name: string; notnull: number }>).find(
        (col) => col.name === "title",
      );
      expect(titleCol?.notnull).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("fresh install replay (Turso primary over @libsql/client)", () => {
  it("applies the repair migration to a database without platform tables", async () => {
    const root = path.join(tmp, "registry");
    writeMigrations(root, { "0002_repair.sql": REPAIR });
    const client = createClient({ url: `file:${path.join(tmp, "remote.db")}` });
    try {
      await client.execute("CREATE TABLE videos (id TEXT PRIMARY KEY, title TEXT)");
      await client.execute("INSERT INTO videos (id, title) VALUES ('v1', NULL)");
      await expect(applyAndRecordMigrationOnTursoPrimary(client, root, "0002_repair")).resolves.toEqual({
        applied: true,
      });
      const tables = (await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map(
        (row) => String(row.name),
      );
      expect(tables).toContain("videos");
      expect(tables.some((name) => name.startsWith("app_files") || name.startsWith("_papr_sync_m"))).toBe(false);
      const title = (await client.execute("SELECT title FROM videos WHERE id = 'v1'")).rows[0]?.title;
      expect(title).toBe("Untitled");
    } finally {
      client.close();
    }
  });
});

let syncConnect: ((opts: { path: string }) => Promise<unknown>) | null = null;
try {
  syncConnect = (await import("@tursodatabase/sync")).connect as typeof syncConnect;
} catch {
  syncConnect = null;
}

describe.skipIf(!syncConnect)("fresh install replay (replica engine)", () => {
  it("skips platform-table statements inside the replica migration transaction", async () => {
    const { runMigrationTransaction } = await import(
      "../../src/gateway/services/tursoReplica/tursoReplicaSyncWorkerCore.js"
    );
    type Db = Parameters<typeof runMigrationTransaction>[0];
    const db = (await syncConnect!({ path: path.join(tmp, "replica.db") })) as Db & {
      exec(sql: string): Promise<void>;
      prepare(sql: string): Promise<{ all(): Promise<Array<Record<string, unknown>>> }>;
      close(): Promise<void>;
    };
    await db.exec(INIT);
    const result = await runMigrationTransaction(db, {
      id: "t",
      localPath: "x",
      tursoUrl: "",
      authToken: "",
      bootstrapIfEmpty: false,
      op: "migrate",
      statements: splitSqlStatements(REPAIR).map((sql) => ({ sql })),
      ledger: [],
    });
    expect(result.executed.every((sql) => !/app_files|_papr_/.test(sql))).toBe(true);
    expect(result.skipped.some((s) => /platform table/.test(s.reason))).toBe(true);
    const names = (await (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")).all()).map(
      (r) => String(r.name),
    );
    expect(names).toContain("videos");
    expect(names.some((name) => name.startsWith("app_files"))).toBe(false);
    await db.close();
  });
});
