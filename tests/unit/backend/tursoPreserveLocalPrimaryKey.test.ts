/**
 * A pull must not strip a PRIMARY KEY the local table still declares.
 *
 * Regression: a PK-less remote schema overwrote the local one on every pull,
 * and the next push copied that back up, so the loss became self-sustaining.
 * The user-visible damage was not a sync error — jobs using
 * `INSERT ... ON CONFLICT(id)` failed with "ON CONFLICT clause does not match
 * any PRIMARY KEY or UNIQUE constraint", and duplicate rows piled up until
 * they did.
 *
 * Uses `node:sqlite` rather than the vendored better-sqlite3, which is built
 * for Electron's ABI and cannot load under plain vitest — same approach as
 * tests/cdc-trigger-atomic-refresh.test.ts.
 */

import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

import {
  writeTablesToLocalDb,
  type LocalTable,
} from "../../../src/gateway/services/tursoSyncBridgeCore.js";

// Required rather than imported: Vite tries to resolve a bare `node:sqlite`
// import and fails. Same approach as tests/cdc-trigger-atomic-refresh.test.ts.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => unknown;
};

/**
 * `node:sqlite` exposes exec/prepare but not the two better-sqlite3 helpers
 * the sync code uses: `.pragma()` and `.transaction()`. Bridging them here
 * keeps the test running the real implementation rather than a
 * reimplementation of it, which is the only version worth asserting against.
 */
function openDb(): any {
  const db = new DatabaseSync(":memory:") as any;
  db.pragma = (statement: string) => db.exec(`PRAGMA ${statement}`);
  db.transaction = (fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      db.exec("BEGIN");
      try {
        const result = fn(...args);
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    };
  return db;
}

function pkColumns(db: any, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    pk: number;
  }>;
  return rows.filter((row) => row.pk > 0).map((row) => row.name);
}

function count(db: any, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as any).n);
}

/** Remote shape after the PK was lost upstream: names and types only. */
function pklessRemote(name: string, rows: unknown[][] = []): LocalTable {
  return {
    name,
    columns: [
      { name: "id", type: "TEXT", primaryKey: false },
      { name: "title", type: "TEXT", primaryKey: false },
    ],
    rows,
  };
}

describe("writeTablesToLocalDb — primary key preservation", () => {
  it("keeps the local PK when the incoming remote schema has none", () => {
    const db = openDb();
    db.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT)`);

    writeTablesToLocalDb(db, [pklessRemote("events", [["a", "One"]])]);

    expect(pkColumns(db, "events")).toEqual(["id"]);
  });

  it("keeps upserts working, so ON CONFLICT does not fail after a pull", () => {
    const db = openDb();
    db.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT)`);

    writeTablesToLocalDb(db, [pklessRemote("events", [["a", "One"]])]);

    // The exact statement shape the calendar job uses.
    expect(() =>
      db
        .prepare(
          `INSERT INTO events (id, title) VALUES (?, ?)
           ON CONFLICT(id) DO UPDATE SET title = excluded.title`,
        )
        .run("a", "Updated"),
    ).not.toThrow();

    const row = db.prepare(`SELECT title FROM events WHERE id = 'a'`).get() as {
      title: string;
    };
    expect(row.title).toBe("Updated");
    expect(count(db, "events")).toBe(1);
  });

  it("respects the remote PK when the remote declares one", () => {
    const db = openDb();
    db.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT)`);

    writeTablesToLocalDb(db, [
      {
        name: "events",
        columns: [
          { name: "id", type: "TEXT", primaryKey: false },
          { name: "title", type: "TEXT", primaryKey: true },
        ],
        rows: [],
      },
    ]);

    // An intentional PK change must still win — this only backfills a *missing* key.
    expect(pkColumns(db, "events")).toEqual(["title"]);
  });

  it("leaves genuinely key-less tables alone", () => {
    const db = openDb();
    db.exec(`CREATE TABLE events (id TEXT, title TEXT)`);

    writeTablesToLocalDb(db, [pklessRemote("events")]);

    expect(pkColumns(db, "events")).toEqual([]);
  });

  it("does not reinstate a PK whose column the remote dropped", () => {
    const db = openDb();
    db.exec(`CREATE TABLE events (legacy_id TEXT PRIMARY KEY, title TEXT)`);

    // A PK naming a column that no longer exists would be invalid DDL.
    expect(() =>
      writeTablesToLocalDb(db, [pklessRemote("events")]),
    ).not.toThrow();
    expect(pkColumns(db, "events")).toEqual([]);
  });

  it("creates tables that do not exist locally yet", () => {
    const db = openDb();

    expect(() =>
      writeTablesToLocalDb(db, [pklessRemote("fresh", [["a", "One"]])]),
    ).not.toThrow();
    expect(count(db, "fresh")).toBe(1);
  });
});
