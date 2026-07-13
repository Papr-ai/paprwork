import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  computeTableFingerprint,
  computeSyncableTableFingerprints,
  fingerprintsEqual,
} from "../src/gateway/services/tursoTableFingerprint.js";

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
});
