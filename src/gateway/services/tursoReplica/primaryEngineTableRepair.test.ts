import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CANONICAL_LAST_CHANGE_ID_SQL,
  inspectPrimaryLastChangeIdTable,
  isPrimaryEngineTableTypeError,
  repairPrimaryLastChangeIdTable,
} from "./primaryEngineTableRepair.js";

/** The shape found on a real primary (Scenario, 2026-10-12): TEXT columns, no key. */
const DEGRADED = 'CREATE TABLE "turso_sync_last_change_id" ("client_id" TEXT, "pull_gen" TEXT, "change_id" TEXT)';

let dir: string;
let db: Client;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "primary-engine-"));
  db = createClient({ url: `file:${path.join(dir, "p.db")}` });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const rows = async () =>
  (await db.execute("SELECT client_id, typeof(pull_gen) t1, pull_gen, typeof(change_id) t2, change_id FROM turso_sync_last_change_id ORDER BY client_id")).rows
    .map((r) => [r.client_id, r.pull_gen, r.t1, r.change_id, r.t2]);

describe("isPrimaryEngineTableTypeError", () => {
  it("matches the engine's errors for the degraded table", () => {
    expect(isPrimaryEngineTableTypeError(
      "sync engine operation failed: database sync engine error: failed to read last_change_id after remote apply: database sync engine error: unexpected source pull_gen type",
    )).toBe(true);
    expect(isPrimaryEngineTableTypeError("unexpected source change_id type")).toBe(true);
    expect(isPrimaryEngineTableTypeError(
      'sync engine operation failed: database sync engine error: failed to execute sql: Error { message: "SQLite error: ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint", code: "SQLITE_UNKNOWN" }',
    )).toBe(true);
    expect(isPrimaryEngineTableTypeError("database is locked")).toBe(false);
  });
});

describe("repairPrimaryLastChangeIdTable", () => {
  it("rebuilds the degraded table and keeps each client's counters as integers", async () => {
    await db.execute(DEGRADED);
    await db.execute("INSERT INTO turso_sync_last_change_id VALUES ('paprwork-desktop-1', '33', '11')");
    await db.execute("CREATE TABLE videos (id TEXT PRIMARY KEY, title TEXT)");
    await db.execute("INSERT INTO videos VALUES ('v1', 'This Was the Deck')");

    expect((await inspectPrimaryLastChangeIdTable(db)).defects).toEqual([
      "client_id is not the primary key", "pull_gen is TEXT, not INTEGER", "change_id is TEXT, not INTEGER",
    ]);
    const out = await repairPrimaryLastChangeIdTable(db);
    expect(out).toMatchObject({ repaired: true, keptRows: 1, droppedRows: 0 });
    expect(await rows()).toEqual([["paprwork-desktop-1", 33, "integer", 11, "integer"]]);
    const sql = (await db.execute("SELECT sql FROM sqlite_master WHERE name='turso_sync_last_change_id'")).rows[0].sql;
    expect(sql).toBe(CANONICAL_LAST_CHANGE_ID_SQL);
    // The engine's upsert needs the unique key the degraded table lacked.
    await db.execute("INSERT INTO turso_sync_last_change_id VALUES ('paprwork-desktop-1', 34, 12) ON CONFLICT(client_id) DO UPDATE SET pull_gen=excluded.pull_gen, change_id=excluded.change_id");
    expect(await rows()).toEqual([["paprwork-desktop-1", 34, "integer", 12, "integer"]]);
    // App data untouched.
    expect((await db.execute("SELECT title FROM videos")).rows[0].title).toBe("This Was the Deck");
    expect((await inspectPrimaryLastChangeIdTable(db)).healthy).toBe(true);
  });

  it("keeps the furthest row per client and drops rows that aren't numbers", async () => {
    await db.execute(DEGRADED);
    await db.execute("INSERT INTO turso_sync_last_change_id VALUES ('a', '3', '9'), ('a', '4', '1'), ('b', 'x', '2'), (NULL, '1', '1')");
    const out = await repairPrimaryLastChangeIdTable(db);
    expect(out).toMatchObject({ repaired: true, keptRows: 1, droppedRows: 3 });
    expect(await rows()).toEqual([["a", 4, "integer", 1, "integer"]]);
  });

  it("leaves a canonical table and a missing table alone", async () => {
    expect(await repairPrimaryLastChangeIdTable(db)).toMatchObject({ repaired: false });
    await db.execute(CANONICAL_LAST_CHANGE_ID_SQL);
    await db.execute("INSERT INTO turso_sync_last_change_id VALUES ('a', 5, 6)");
    expect(await repairPrimaryLastChangeIdTable(db)).toMatchObject({ repaired: false });
    expect(await rows()).toEqual([["a", 5, "integer", 6, "integer"]]);
  });
});
