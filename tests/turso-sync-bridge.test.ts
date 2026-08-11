import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { jobTursoDatabaseName, tursoShortNameForChangeInput } from "../src/gateway/services/tursoDatabaseNaming.js";
import {
  applyPulledTablesToLocalDb,
  buildCreateTableSql,
  ensureLocalDbChangeLogReady,
  filterSyncableTables,
  isSqliteBusyError,
  listUserTables,
  pullTursoToLocalDb,
  pushLocalDbToTurso,
  quoteIdent,
  readLocalTable,
  readTableCreateSql,
  resetChangeLogReadyCacheForTests,
  sortTablesForInsert,
  toLocalTableName,
  toRemoteTableName,
  type LocalTable,
} from "../src/gateway/services/tursoSyncBridgeCore.js";
import {
  discoverTursoLinkedSources,
  listLinkedJobIdsForTursoSync,
} from "../src/gateway/services/tursoLinkedSources.js";

let canUseBetterSqlite = false;
try {
  const probe = new Database(":memory:");
  probe.close();
  canUseBetterSqlite = true;
} catch {
  canUseBetterSqlite = false;
}

describe("tursoSyncBridgeCore", () => {
  it("jobTursoDatabaseName uses first 8 hex chars of job id", () => {
    expect(jobTursoDatabaseName("de1a89d8-1234-5678-abcd-ef0123456789")).toBe(
      "j-de1a89d8",
    );
  });

  it("tursoShortNameForChangeInput resolves jobId, dbId, or explicit short name", () => {
    expect(
      tursoShortNameForChangeInput({ jobId: "de1a89d8-1234-5678-abcd-ef0123456789" }),
    ).toBe("j-de1a89d8");
    expect(tursoShortNameForChangeInput({ dbId: "db-deadbeef" })).toBe("d-deadbeef");
    expect(
      tursoShortNameForChangeInput({ tursoShortName: "d-custom01" }),
    ).toBe("d-custom01");
    expect(tursoShortNameForChangeInput({})).toBeUndefined();
  });

  it("per-job DB uses unprefixed table names", () => {
    expect(toRemoteTableName("tweets", "abc-123")).toBe("tweets");
    expect(toLocalTableName("tweets", "abc-123")).toBe("tweets");
    expect(toLocalTableName("job_runs", "abc-123")).toBeNull();
  });

  it("filterSyncableTables excludes job scratch tables", () => {
    expect(
      filterSyncableTables(["tweets", "job_runs", "job_events", "schema_migrations"]),
    ).toEqual(["tweets"]);
  });

  it("quoteIdent escapes double quotes", () => {
    expect(quoteIdent('foo"bar')).toBe('"foo""bar"');
  });

  it.skipIf(!canUseBetterSqlite)(
    "listUserTables excludes sqlite metadata tables",
    () => {
      const db = new Database(":memory:");
      db.exec(`
      CREATE TABLE tweets (id INTEGER PRIMARY KEY, content TEXT);
      CREATE TABLE sqlite_sequence (name TEXT);
    `);
      expect(listUserTables(db)).toEqual(["tweets"]);
      db.close();
    },
  );

  it.skipIf(!canUseBetterSqlite)("readLocalTable returns rows and schema", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)");
    db.prepare("INSERT INTO items (label) VALUES (?)").run("alpha");
    const table = readLocalTable(db, "items");
    expect(table.columns).toHaveLength(2);
    expect(table.rows).toEqual([[1, "alpha"]]);
    expect(table.createSql).toContain("CREATE TABLE");
    db.close();
  });

  it.skipIf(!canUseBetterSqlite)(
    "buildCreateTableSql preserves NOT NULL and DEFAULT from sqlite_master",
    () => {
      const db = new Database(":memory:");
      db.exec(`
        CREATE TABLE audits (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contact_name TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      const originalSql = readTableCreateSql(db, "audits");
      expect(originalSql).toBeTruthy();

      const table = readLocalTable(db, "audits");
      expect(buildCreateTableSql(table)).toBe(originalSql);

      db.exec("DROP TABLE audits");
      db.exec(buildCreateTableSql(table));

      const roundTrip = readTableCreateSql(db, "audits");
      expect(roundTrip).toBeTruthy();
      expect(roundTrip).toContain("NOT NULL");
      expect(roundTrip).toContain("DEFAULT");

      const info = db.prepare("PRAGMA table_info(audits)").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      const contactName = info.find((col) => col.name === "contact_name");
      const createdAt = info.find((col) => col.name === "created_at");
      expect(contactName?.notnull).toBe(1);
      expect(createdAt?.notnull).toBe(1);
      expect(createdAt?.dflt_value).toBeTruthy();
      db.close();
    },
  );

  it.skipIf(!canUseBetterSqlite)(
    "ensureLocalDbChangeLogReady installs infra once per session",
    () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "papr-changelog-"));
      const dbPath = path.join(base, "data.db");
      try {
        const db = new Database(dbPath);
        db.exec("CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT)");
        db.close();

        resetChangeLogReadyCacheForTests();
        ensureLocalDbChangeLogReady(dbPath);
        ensureLocalDbChangeLogReady(dbPath);

        const verify = new Database(dbPath, { readonly: true });
        const row = verify
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_papr_sync_log'",
          )
          .get() as { name: string } | undefined;
        verify.close();
        expect(row?.name).toBe("_papr_sync_log");
      } finally {
        resetChangeLogReadyCacheForTests();
        fs.rmSync(base, { recursive: true, force: true });
      }
    },
  );

  it("isSqliteBusyError detects SQLITE_BUSY", () => {
    expect(isSqliteBusyError({ code: "SQLITE_BUSY" })).toBe(true);
    expect(isSqliteBusyError(new Error("database is locked"))).toBe(false);
  });

  it("pushLocalDbToTurso skips missing database", async () => {
    const result = await pushLocalDbToTurso(
      "/tmp/does-not-exist.db",
      {
        tursoUrl: "libsql://example.turso.io",
        authToken: "token",
      },
      { jobId: "job-1" },
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("local_db_missing");
  });

  it("pullTursoToLocalDb creates parent directory", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "papr-turso-pull-"));
    const dbPath = path.join(base, "nested", "data.db");
    try {
      await expect(
        pullTursoToLocalDb(
          dbPath,
          {
            tursoUrl: "libsql://invalid.example.turso.io",
            authToken: "bad-token",
          },
          { jobId: "job-1" },
        ),
      ).rejects.toThrow();
      expect(fs.existsSync(path.dirname(dbPath))).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it.skipIf(!canUseBetterSqlite)("sortTablesForInsert orders parents before children", () => {
    const campaigns: LocalTable = {
      name: "campaigns",
      columns: [{ name: "id", type: "INTEGER", primaryKey: true }],
      rows: [[1]],
    };
    const leads: LocalTable = {
      name: "leads",
      columns: [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "campaign_id", type: "INTEGER", primaryKey: false },
      ],
      rows: [[10, 1]],
    };
    const fkRefs = new Map<string, readonly string[]>([
      ["leads", ["campaigns"]],
    ]);
    const ordered = sortTablesForInsert([leads, campaigns], fkRefs);
    expect(ordered.map((t) => t.name)).toEqual(["campaigns", "leads"]);
  });

  it("buildCreateTableSql uses table-level PRIMARY KEY for composite keys", () => {
    const sql = buildCreateTableSql({
      name: "sessions",
      columns: [
        { name: "user_id", type: "TEXT", primaryKey: true },
        { name: "session_id", type: "TEXT", primaryKey: true },
        { name: "created_at", type: "TEXT", primaryKey: false },
      ],
      rows: [],
    });
    expect(sql).toContain('PRIMARY KEY ("user_id", "session_id")');
    expect(sql.match(/PRIMARY KEY/g)?.length).toBe(1);
  });

  it.skipIf(!canUseBetterSqlite)(
    "applyPulledTablesToLocalDb replaces FK-linked tables without constraint errors",
    () => {
      const db = new Database(":memory:");
      db.pragma("foreign_keys = ON");
      db.exec(`
        CREATE TABLE campaigns (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE leads (
          id INTEGER PRIMARY KEY,
          campaign_id INTEGER NOT NULL REFERENCES campaigns(id)
        );
        INSERT INTO campaigns (id, name) VALUES (1, 'old');
        INSERT INTO leads (id, campaign_id) VALUES (10, 1);
      `);

      const campaignsSql = readTableCreateSql(db, "campaigns");
      const leadsSql = readTableCreateSql(db, "leads");
      expect(leadsSql).toContain("REFERENCES");

      const pulled: LocalTable[] = [
        {
          name: "leads",
          columns: [
            { name: "id", type: "INTEGER", primaryKey: true },
            { name: "campaign_id", type: "INTEGER", primaryKey: false },
          ],
          rows: [[20, 2]],
          createSql: leadsSql,
        },
        {
          name: "campaigns",
          columns: [
            { name: "id", type: "INTEGER", primaryKey: true },
            { name: "name", type: "TEXT", primaryKey: false },
          ],
          rows: [[2, "new"]],
          createSql: campaignsSql,
        },
      ];

      expect(() => applyPulledTablesToLocalDb(db, pulled)).not.toThrow();

      const roundTripLeadsSql = readTableCreateSql(db, "leads");
      expect(roundTripLeadsSql).toContain("REFERENCES");

      const campaigns = db
        .prepare("SELECT id, name FROM campaigns ORDER BY id")
        .all() as Array<{ id: number; name: string }>;
      const leads = db
        .prepare("SELECT id, campaign_id FROM leads ORDER BY id")
        .all() as Array<{ id: number; campaign_id: number }>;

      expect(campaigns).toEqual([{ id: 2, name: "new" }]);
      expect(leads).toEqual([{ id: 20, campaign_id: 2 }]);
      db.close();
    },
  );
});

describe("tursoLinkedSources", () => {
  it("discovers primary linked sources and skips scratch", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "papr-apps-"));
    const appDir = path.join(root, "app-1");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "data-sources.json"),
      JSON.stringify({
        primary: "main",
        sources: [
          {
            id: "job-a:main",
            type: "sqlite",
            jobId: "job-a",
            alias: "main",
            dbPath: "/tmp/job-a/data.db",
            tables: [],
            linkedAt: "2026-01-01T00:00:00.000Z",
            role: "primary",
          },
          {
            id: "job-b:scratch",
            type: "sqlite",
            jobId: "job-b",
            alias: "scratch",
            dbPath: "/tmp/job-b/data.db",
            tables: [],
            linkedAt: "2026-01-01T00:00:00.000Z",
            role: "scratch",
          },
        ],
      }),
    );

    const sources = await discoverTursoLinkedSources(root);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.jobId).toBe("job-a");
    expect(sources[0]?.role).toBe("primary");

    const app2Dir = path.join(root, "app-2");
    fs.mkdirSync(app2Dir, { recursive: true });
    fs.writeFileSync(
      path.join(app2Dir, "data-sources.json"),
      JSON.stringify([
        {
          id: "job-c:legacy",
          type: "sqlite",
          jobId: "job-c",
          alias: "legacy",
          dbPath: "/tmp/job-c/data.db",
          tables: [],
          linkedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );
    const all = await discoverTursoLinkedSources(root);
    expect(all.map((s) => s.jobId).sort()).toEqual(["job-a", "job-c"]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("listLinkedJobIdsForTursoSync only returns jobs with existing db files", async () => {
    const appsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "papr-apps-"));
    const jobsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "papr-jobs-"));
    const jobId = "linked-job";
    const dbPath = path.join(jobsRoot, jobId, "data", "data.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, "sqlite");

    const appDir = path.join(appsRoot, "dashboard");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "data-sources.json"),
      JSON.stringify([
        {
          id: `${jobId}:main`,
          type: "sqlite",
          jobId,
          alias: "main",
          dbPath,
          tables: [],
          linkedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );

    const jobIds = await listLinkedJobIdsForTursoSync(appsRoot);
    expect(jobIds).toEqual([jobId]);

    fs.rmSync(appsRoot, { recursive: true, force: true });
    fs.rmSync(jobsRoot, { recursive: true, force: true });
  });
});
