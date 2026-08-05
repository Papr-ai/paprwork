import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  computeTableFingerprint,
  computeSyncableTableFingerprints,
  fingerprintsEqual,
  fullSchemasMatch,
  isPlatformManagedColumn,
  userSchemasMatch,
  userSchemaColumns,
} from "../src/gateway/services/tursoTableFingerprint.js";
import { PAPR_ROW_SYNC_COLUMNS } from "../src/core/types/jobMigrations.js";

let canUseBetterSqlite = false;
try {
  const probe = new Database(":memory:");
  probe.close();
  canUseBetterSqlite = true;
} catch {
  canUseBetterSqlite = false;
}

describe("tursoTableFingerprint", () => {
  it.skipIf(!canUseBetterSqlite)("stable fingerprint for unchanged table", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT);
      INSERT INTO items (label) VALUES ('alpha');
    `);
    const first = computeTableFingerprint(db, "items");
    const second = computeTableFingerprint(db, "items");
    expect(first).toBe(second);
    db.close();
  });

  it.skipIf(!canUseBetterSqlite)("fingerprint changes when row content changes", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT);
      INSERT INTO items (label) VALUES ('alpha');
    `);
    const before = computeTableFingerprint(db, "items");
    db.prepare("UPDATE items SET label = ? WHERE id = 1").run("beta");
    const after = computeTableFingerprint(db, "items");
    expect(before).not.toBe(after);
    db.close();
  });

  it.skipIf(!canUseBetterSqlite)("computeSyncableTableFingerprints skips scratch tables", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE tweets (id INTEGER PRIMARY KEY, body TEXT);
      CREATE TABLE job_events (id INTEGER PRIMARY KEY, msg TEXT);
      INSERT INTO tweets (body) VALUES ('hello');
      INSERT INTO job_events (msg) VALUES ('evt');
    `);
    const fps = computeSyncableTableFingerprints(db);
    expect(Object.keys(fps)).toEqual(["tweets"]);
    db.close();
  });

  it("fingerprintsEqual compares full maps", () => {
    expect(
      fingerprintsEqual({ a: "1", b: "2" }, { a: "1", b: "2" }),
    ).toBe(true);
    expect(
      fingerprintsEqual({ a: "1" }, { a: "2" }),
    ).toBe(false);
    expect(fingerprintsEqual({ a: "1" }, undefined)).toBe(false);
  });

  it("isPlatformManagedColumn detects _papr_ columns", () => {
    expect(isPlatformManagedColumn(PAPR_ROW_SYNC_COLUMNS.createdAt)).toBe(true);
    expect(isPlatformManagedColumn("title")).toBe(false);
  });

  it("userSchemasMatch ignores platform _papr_* columns", () => {
    const userOnly = [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "title", type: "TEXT", primaryKey: false },
    ];
    const withPlatform = [
      ...userOnly,
      { name: PAPR_ROW_SYNC_COLUMNS.createdAt, type: "TEXT", primaryKey: false },
      { name: PAPR_ROW_SYNC_COLUMNS.updatedAt, type: "TEXT", primaryKey: false },
      { name: PAPR_ROW_SYNC_COLUMNS.rowVersion, type: "INTEGER", primaryKey: false },
    ];
    expect(userSchemasMatch(userOnly, withPlatform)).toBe(true);
    expect(fullSchemasMatch(userOnly, withPlatform)).toBe(false);
    expect(userSchemaColumns(withPlatform)).toHaveLength(2);
  });

  it("userSchemasMatch still detects user column drift", () => {
    const left = [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "title", type: "TEXT", primaryKey: false },
    ];
    const right = [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "title", type: "TEXT", primaryKey: false },
      { name: "contact_name", type: "TEXT", primaryKey: false },
    ];
    expect(userSchemasMatch(left, right)).toBe(false);
    expect(fullSchemasMatch(left, right)).toBe(false);
  });

  it("fullSchemasMatch ignores PRAGMA column order", () => {
    const a = [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "title", type: "TEXT", primaryKey: false },
      { name: "contact_name", type: "TEXT", primaryKey: false },
    ];
    const b = [
      { name: "contact_name", type: "TEXT", primaryKey: false },
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "title", type: "TEXT", primaryKey: false },
    ];
    expect(fullSchemasMatch(a, b)).toBe(true);
  });
});
