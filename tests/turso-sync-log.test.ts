import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  compactSyncLogEntries,
  ensureLocalSyncInfrastructure,
  ensureLocalTableSyncTriggers,
  isSqliteTriggerAlreadyExistsError,
  maxSyncLogId,
  pruneSyncLogThrough,
  readSyncLogSince,
  withSyncMuted,
} from "../src/gateway/services/tursoSyncLog.js";

let canUseBetterSqlite = false;
try {
  const probe = new Database(":memory:");
  probe.close();
  canUseBetterSqlite = true;
} catch {
  canUseBetterSqlite = false;
}

describe("tursoSyncLog", () => {
  it("isSqliteTriggerAlreadyExistsError detects duplicate trigger messages", () => {
    expect(
      isSqliteTriggerAlreadyExistsError(
        'trigger "_papr_tr_audit_moves_au" already exists',
      ),
    ).toBe(true);
    expect(isSqliteTriggerAlreadyExistsError("no such table: foo")).toBe(false);
  });

  it("compactSyncLogEntries keeps the last op per table and primary key", () => {
    const compacted = compactSyncLogEntries([
      { id: 1, tableName: "events", op: "insert", rowPk: [1] },
      { id: 2, tableName: "events", op: "update", rowPk: [1] },
      { id: 3, tableName: "events", op: "delete", rowPk: [1] },
    ]);
    expect(compacted).toHaveLength(1);
    expect(compacted[0]?.op).toBe("delete");
  });

  it.skipIf(!canUseBetterSqlite)(
    "records insert/update/delete in changelog when triggers installed",
    () => {
      const db = new Database(":memory:");
      db.exec(`
        CREATE TABLE records (
          id INTEGER PRIMARY KEY,
          label TEXT NOT NULL
        );
      `);
      ensureLocalTableSyncTriggers(db, "records");

      db.prepare("INSERT INTO records (label) VALUES (?)").run("alpha");
      db.prepare("UPDATE records SET label = ? WHERE id = 1").run("beta");
      db.prepare("DELETE FROM records WHERE id = 1").run();

      const entries = readSyncLogSince(db, 0);
      expect(entries).toHaveLength(3);
      expect(entries.map((entry) => entry.op)).toEqual([
        "insert",
        "update",
        "delete",
      ]);
      expect(entries[0]?.rowPk).toEqual([1]);
      db.close();
    },
  );

  it.skipIf(!canUseBetterSqlite)(
    "withSyncMuted suppresses changelog entries during apply",
    () => {
      const db = new Database(":memory:");
      db.exec(`
        CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT);
      `);
      ensureLocalTableSyncTriggers(db, "items");

      withSyncMuted(db, () => {
        db.prepare("INSERT INTO items (value) VALUES (?)").run("muted");
      });
      db.prepare("INSERT INTO items (value) VALUES (?)").run("visible");

      const entries = readSyncLogSince(db, 0);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.op).toBe("insert");
      db.close();
    },
  );

  it.skipIf(!canUseBetterSqlite)("pruneSyncLogThrough removes applied entries", () => {
    const db = new Database(":memory:");
    ensureLocalSyncInfrastructure(db);
    db.exec(`
      CREATE TABLE widgets (id INTEGER PRIMARY KEY);
    `);
    ensureLocalTableSyncTriggers(db, "widgets");
    db.prepare("INSERT INTO widgets (id) VALUES (1)").run();
    db.prepare("INSERT INTO widgets (id) VALUES (2)").run();

    const before = readSyncLogSince(db, 0);
    expect(before.length).toBeGreaterThanOrEqual(2);
    const maxId = maxSyncLogId(db);
    pruneSyncLogThrough(db, maxId);
    expect(readSyncLogSince(db, 0)).toHaveLength(0);
    db.close();
  });

  it.skipIf(!canUseBetterSqlite)(
    "single row change on large table logs one changelog entry",
    () => {
      const db = new Database(":memory:");
      db.exec(`
        CREATE TABLE big_data (
          id INTEGER PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      ensureLocalTableSyncTriggers(db, "big_data");

      const insert = db.prepare("INSERT INTO big_data (id, value) VALUES (?, ?)");
      const batch = db.transaction((rows: number) => {
        for (let i = 1; i <= rows; i += 1) {
          insert.run(i, `row-${i}`);
        }
      });
      batch(2500);

      const afterBulk = readSyncLogSince(db, 0);
      expect(afterBulk).toHaveLength(2500);

      const lastId = afterBulk[afterBulk.length - 1]!.id;
      db.prepare("UPDATE big_data SET value = ? WHERE id = 2500").run("changed");

      const delta = readSyncLogSince(db, lastId);
      expect(delta).toHaveLength(1);
      expect(delta[0]?.op).toBe("update");
      expect(delta[0]?.rowPk).toEqual([2500]);
      db.close();
    },
  );

  it.skipIf(!canUseBetterSqlite)(
    "update logs one changelog entry (metadata bump excluded)",
    () => {
      const db = new Database(":memory:");
      db.exec(`
        CREATE TABLE records (
          id INTEGER PRIMARY KEY,
          label TEXT NOT NULL
        );
      `);
      ensureLocalTableSyncTriggers(db, "records");
      db.prepare("INSERT INTO records (label) VALUES (?)").run("alpha");
      const afterInsert = readSyncLogSince(db, 0);
      expect(afterInsert).toHaveLength(1);

      db.prepare("UPDATE records SET label = ? WHERE id = 1").run("beta");
      const afterUpdate = readSyncLogSince(db, afterInsert[0]!.id);
      expect(afterUpdate).toHaveLength(1);
      expect(afterUpdate[0]?.op).toBe("update");
      db.close();
    },
  );

  it.skipIf(!canUseBetterSqlite)(
    "skips trigger install for tables without primary key",
    () => {
      const db = new Database(":memory:");
      db.exec(`CREATE TABLE no_pk (label TEXT);`);
      const installed = ensureLocalTableSyncTriggers(db, "no_pk");
      expect(installed).toBe(false);
      db.prepare("INSERT INTO no_pk (label) VALUES (?)").run("x");
      expect(readSyncLogSince(db, 0)).toHaveLength(0);
      db.close();
    },
  );
});
