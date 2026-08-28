import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  filterSyncableTables,
  listUserTables,
} from "../src/gateway/services/tursoSyncBridgeCore.js";
import {
  isLegacyCdcArtifactTable,
  listLegacyCdcArtifactTablesForPath,
  stripLegacyCdcArtifacts,
} from "../src/gateway/services/legacyCdcArtifacts.js";

let canUseBetterSqlite = false;
try {
  const probe = new Database(":memory:");
  probe.close();
  canUseBetterSqlite = true;
} catch {
  canUseBetterSqlite = false;
}

describe("legacyCdcArtifacts", () => {
  it("recognizes known legacy CDC table names", () => {
    expect(isLegacyCdcArtifactTable("turso_sync_last_change_id")).toBe(true);
    expect(isLegacyCdcArtifactTable("turso_cdc_log")).toBe(true);
    expect(isLegacyCdcArtifactTable("turso_cdc")).toBe(true);
    expect(isLegacyCdcArtifactTable("turso_cdc_version")).toBe(true);
    expect(
      isLegacyCdcArtifactTable(
        "__turso_internal_seq___turso_internal_autoincrement_turso_cdc",
      ),
    ).toBe(true);
    expect(isLegacyCdcArtifactTable("contacts")).toBe(false);
    expect(isLegacyCdcArtifactTable("_papr_sync_log")).toBe(false);
  });

  it.skipIf(!canUseBetterSqlite)(
    "excludes legacy artifacts from syncable table counts",
    () => {
      const db = new Database(":memory:");
      db.exec(`
        CREATE TABLE contacts (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE turso_sync_last_change_id (id INTEGER PRIMARY KEY, value INTEGER);
      `);
      const syncable = filterSyncableTables(listUserTables(db));
      expect(syncable).toEqual(["contacts"]);
      db.close();
    },
  );

  it.skipIf(!canUseBetterSqlite)("stripLegacyCdcArtifacts drops artifact tables", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-artifact-"));
    const dbPath = path.join(dir, "data.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE contacts (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE turso_sync_last_change_id (id INTEGER PRIMARY KEY, value INTEGER);
      INSERT INTO contacts (name) VALUES ('Acme');
    `);
    db.close();

    expect(listLegacyCdcArtifactTablesForPath(dbPath)).toEqual([
      "turso_sync_last_change_id",
    ]);

    const dropped = stripLegacyCdcArtifacts(dbPath);
    expect(dropped).toEqual(["turso_sync_last_change_id"]);
    expect(listLegacyCdcArtifactTablesForPath(dbPath)).toEqual([]);

    const after = new Database(dbPath, { readonly: true });
    expect(filterSyncableTables(listUserTables(after))).toEqual(["contacts"]);
    after.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cutover classify with legacy artifacts", () => {
  afterEach(async () => {
    const { vi } = await import("vitest");
    vi.resetModules();
    delete process.env.PAPR_TURSO_REPLICA_SYNC;
    delete process.env.CLOUD_SYNC_ENABLED;
  });

  it("does not block cutover when only legacyArtifactTables differ", async () => {
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
    process.env.CLOUD_SYNC_ENABLED = "true";

    const { vi } = await import("vitest");
    vi.doMock(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverSnapshot.js",
      () => ({
        snapshotLegacyRecordForCutover: vi.fn(async () => ({
          dbExists: true,
          localTableCount: 11,
          remoteTableCount: 11,
          schemaDrift: false,
          legacyArtifactTables: ["turso_sync_last_change_id"],
          remoteCheckFailed: false,
          dirty: false,
          quarantined: false,
          localMigrationIds: [],
          remoteMigrationIds: [],
          migrationConflict: false,
        })),
      }),
    );

    const { classifyRecordForReplicaCutover: classify } = await import(
      "../src/gateway/services/tursoReplica/cutover/tursoReplicaCutoverClassify.js"
    );

    const result = await classify({
      dbId: "db-test",
      localPath: "/tmp/data.db",
      tursoShortName: "d-test0001",
      isolation: "shared",
      status: "active",
      syncMode: "legacy",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(result.bucket).toBe("pull_remote");
    expect(result.snapshot.legacyArtifactTables).toEqual([
      "turso_sync_last_change_id",
    ]);
  });
});
