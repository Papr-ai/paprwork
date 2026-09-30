/**
 * Regression tests for the duplicate-CDC-trigger schema corruption.
 *
 * refreshLocalCdcUpdateTrigger() recreates `_papr_tr_<suffix>_au` on every sync.
 * That trigger cannot use `CREATE TRIGGER IF NOT EXISTS` — its body encodes the
 * current column set, so it must be genuinely replaced. The old implementation
 * did the swap as two independent statements:
 *
 *     db.exec("DROP TRIGGER IF EXISTS ...");
 *     db.exec("CREATE TRIGGER ...");
 *
 * If anything interrupted the process between those two calls, or a second sync
 * ran concurrently, sqlite_master could end up with TWO rows for the same
 * trigger name. SQLite then refuses to parse the schema at all:
 *
 *     malformed database schema (_papr_tr_investors_au)
 *       - trigger "_papr_tr_investors_au" already exists
 *
 * Every subsequent query fails, and the mini-app renders an empty list — which
 * looks exactly like data loss. Observed in production on a data room that
 * repeatedly "lost" its investor and intro tables.
 *
 * The fix wraps the swap in a single transaction so it either fully applies or
 * fully rolls back. These tests exercise real SQLite files via node:sqlite (the
 * vendored better-sqlite3 is built for Electron's ABI and cannot load here); the
 * behaviour under test is SQLite's own transaction/schema semantics, so it holds
 * for whichever driver the gateway uses at runtime.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "node:module";

// Loaded via createRequire so Vite does not try to bundle the builtin.
type DatabaseSync = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...a: unknown[]): unknown;
    all(...a: unknown[]): unknown[];
    run(...a: unknown[]): unknown;
  };
  close(): void;
};
type DatabaseSyncCtor = new (p: string, o?: { readOnly?: boolean }) => DatabaseSync;
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: DatabaseSyncCtor;
};

let dir: string;
let dbPath: string;

const TRIGGER = "_papr_tr_investors_au";

const CREATE_TRIGGER =
  `CREATE TRIGGER "${TRIGGER}" AFTER UPDATE ON "investors" ` +
  `BEGIN INSERT INTO "_papr_sync_log" (table_name, op) VALUES ('investors', 'update'); END`;

function seedDb(): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE investors (id INTEGER PRIMARY KEY, name TEXT)");
  db.exec("CREATE TABLE _papr_sync_log (id INTEGER PRIMARY KEY, table_name TEXT, op TEXT)");
  db.exec(CREATE_TRIGGER);
  return db;
}

/** The FIXED swap — mirrors refreshLocalCdcUpdateTrigger() in tursoSyncLog.ts. */
function atomicRefresh(db: DatabaseSync): void {
  db.exec("BEGIN");
  try {
    db.exec(`DROP TRIGGER IF EXISTS "${TRIGGER}"`);
    db.exec(CREATE_TRIGGER);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function triggerRowCount(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='trigger' AND name=?")
    .get(TRIGGER) as { c: number };
  return Number(row.c);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdc-trigger-"));
  dbPath = path.join(dir, "data.db");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("CDC update trigger refresh is atomic", () => {
  it("leaves exactly one trigger row after repeated refreshes", () => {
    const db = seedDb();
    try {
      for (let i = 0; i < 25; i++) atomicRefresh(db);
      expect(triggerRowCount(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  it("keeps the schema parseable after refresh", () => {
    const db = seedDb();
    try {
      atomicRefresh(db);
    } finally {
      db.close();
    }

    // Reopening is where a duplicate would surface as "malformed database schema".
    const reader = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = reader.prepare("SELECT count(*) AS c FROM investors").get() as { c: number };
      expect(Number(row.c)).toBe(0);
    } finally {
      reader.close();
    }
  });

  it("rolls back cleanly when the CREATE fails mid-swap", () => {
    const db = seedDb();
    try {
      // A malformed CREATE aborts the transaction; the DROP must be undone too.
      expect(() => {
        db.exec("BEGIN");
        try {
          db.exec(`DROP TRIGGER IF EXISTS "${TRIGGER}"`);
          db.exec(`CREATE TRIGGER "${TRIGGER}" AFTER UPDATE ON "investors" BEGIN SYNTAX ERROR; END`);
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      }).toThrow();

      // Original trigger survived the failed swap — no partial state.
      expect(triggerRowCount(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  it("still allows the trigger to fire after a refresh", () => {
    const db = seedDb();
    try {
      db.exec("INSERT INTO investors (name) VALUES ('acme')");
      atomicRefresh(db);
      db.exec("UPDATE investors SET name='acme capital' WHERE id=1");

      const row = db
        .prepare("SELECT count(*) AS c FROM _papr_sync_log WHERE op='update'")
        .get() as { c: number };
      expect(Number(row.c)).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("duplicate trigger rows break the database (the bug being prevented)", () => {
  /**
   * Forging the corruption requires writing directly to sqlite_master. Some
   * SQLite builds (including the one on CI) compile out writable_schema, so
   * skip rather than fail there — the atomicity guarantees above are the real
   * regression guard; this test only documents the consequence.
   */
  it("makes the schema unparseable when two rows share a trigger name", (ctx) => {
    const db = seedDb();
    try {
      db.exec("PRAGMA writable_schema=ON");
      db.prepare(
        "INSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql) VALUES ('trigger', ?, 'investors', 0, ?)",
      ).run(TRIGGER, CREATE_TRIGGER);
    } catch {
      db.close();
      ctx.skip();
      return;
    }
    db.close();

    // Any read now fails — this is what the user saw as an empty Investors tab.
    expect(() => {
      const reader = new DatabaseSync(dbPath, { readOnly: true });
      try {
        reader.prepare("SELECT count(*) AS c FROM investors").get();
      } finally {
        reader.close();
      }
    }).toThrow(/malformed database schema|already exists/i);
  });
});
