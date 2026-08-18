/**
 * A pull must not strip a PRIMARY KEY the local table still declares.
 *
 * Regression: a PK-less remote schema overwrote the local one on every pull,
 * and the next push copied that back up, so the loss became self-sustaining.
 * The user-visible damage was not a sync error — jobs using
 * `INSERT ... ON CONFLICT(id)` failed with "ON CONFLICT clause does not match
 * any PRIMARY KEY or UNIQUE constraint", and duplicate rows piled up until
 * they did.
 */

import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import {
  writeTablesToLocalDb,
  type LocalTable,
} from "../../../src/gateway/services/tursoSyncBridgeCore.js";

function pkColumns(db: Database.Database, table: string): string[] {
  const rows = db
    .prepare(`SELECT name, pk FROM pragma_table_info(?)`)
    .all(table) as Array<{ name: string; pk: number }>;
  return rows.filter((row) => row.pk > 0).map((row) => row.name);
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
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT)`);

    writeTablesToLocalDb(db, [pklessRemote("events", [["a", "One"]])]);

    expect(pkColumns(db, "events")).toEqual(["id"]);
  });

  it("keeps upserts working, so ON CONFLICT does not fail after a pull", () => {
    const db = new Database(":memory:");
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
    expect(db.prepare(`SELECT COUNT(*) n FROM events`).get()).toEqual({ n: 1 });
  });

  it("respects the remote PK when the remote declares one", () => {
    const db = new Database(":memory:");
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
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE events (id TEXT, title TEXT)`);

    writeTablesToLocalDb(db, [pklessRemote("events")]);

    expect(pkColumns(db, "events")).toEqual([]);
  });

  it("does not reinstate a PK whose column the remote dropped", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE events (legacy_id TEXT PRIMARY KEY, title TEXT)`);

    // A PK naming a column that no longer exists would be invalid DDL.
    expect(() =>
      writeTablesToLocalDb(db, [pklessRemote("events")]),
    ).not.toThrow();
    expect(pkColumns(db, "events")).toEqual([]);
  });

  it("creates tables that do not exist locally yet", () => {
    const db = new Database(":memory:");

    expect(() =>
      writeTablesToLocalDb(db, [pklessRemote("fresh", [["a", "One"]])]),
    ).not.toThrow();
    expect(db.prepare(`SELECT COUNT(*) n FROM fresh`).get()).toEqual({ n: 1 });
  });
});
