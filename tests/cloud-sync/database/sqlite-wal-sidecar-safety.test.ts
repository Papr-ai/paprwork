/**
 * Regression tests for the "mini-app shows an empty list" data-loss class of bug.
 *
 * Two independent defects combined to make a healthy database look empty:
 *
 *   1. Turso sync called cleanupSqliteSidecars(), which unlinked `-wal`/`-shm`
 *      outright. A non-empty `-wal` holds committed pages not yet folded into
 *      the main file, so deleting it destroys rows.
 *   2. Deleting `-shm` also breaks READ-ONLY opens of a WAL database, which fail
 *      with SQLITE_IOERR. The mini-app caught that and rendered stub/empty data,
 *      so an infra error was indistinguishable from data loss.
 *
 * Uses node:sqlite (built into Node 22) rather than better-sqlite3 so the suite
 * runs under plain `vitest` — better-sqlite3 here is compiled for Electron's ABI.
 * The file-level semantics under test (WAL, -shm, checkpoint) are SQLite's own,
 * so they hold for whichever driver the gateway uses at runtime.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "node:module";

// Loaded via createRequire so Vite does not try to bundle the builtin.
type DatabaseSync = {
  exec(sql: string): void;
  prepare(sql: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown };
  close(): void;
};
type DatabaseSyncCtor = new (p: string, o?: { readOnly?: boolean }) => DatabaseSync;
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: DatabaseSyncCtor;
};

let dir: string;
let dbPath: string;

/**
 * Create a WAL-mode DB whose newest rows live ONLY in the -wal file.
 *
 * Closing a connection checkpoints the WAL, so we build the DB in a staging
 * directory and copy `data.db` + `data.db-wal` out while the writer is still
 * open. That is precisely what backup/sync tooling does, and it is how a
 * non-empty `-wal` reaches disk next to an out-of-date main file.
 */
function seedWalDb(rowCount: number): void {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "wal-stage-"));
  const stagePath = path.join(stage, "data.db");
  const db = new DatabaseSync(stagePath);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA wal_autocheckpoint = 0"); // keep pages in -wal
    db.exec("CREATE TABLE investors (id INTEGER PRIMARY KEY, name TEXT)");
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO investors (name) VALUES (?)");
    for (let i = 0; i < rowCount; i++) insert.run(`investor-${i}`);
    db.exec("COMMIT");

    // Copy while the writer is still open — no checkpoint has run yet.
    fs.copyFileSync(stagePath, dbPath);
    for (const suffix of ["-wal", "-shm"]) {
      if (fs.existsSync(stagePath + suffix)) {
        fs.copyFileSync(stagePath + suffix, dbPath + suffix);
      }
    }
  } finally {
    db.close();
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function countInvestors(readOnly: boolean): number {
  const db = new DatabaseSync(dbPath, { readOnly });
  try {
    const row = db.prepare("SELECT count(*) AS c FROM investors").get() as { c: number };
    return Number(row.c);
  } finally {
    db.close();
  }
}

/**
 * The FIXED cleanup: checkpoint the WAL into the main file before removing
 * sidecars. Mirrors cleanupSqliteSidecars() in tursoSyncBridgeCore.ts.
 */
function safeCleanupSidecars(target: string): void {
  const walPath = target + "-wal";
  let walSize = 0;
  try {
    walSize = fs.statSync(walPath).size;
  } catch {
    walSize = 0;
  }

  if (walSize > 0) {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(target);
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      return; // locked — never delete sidecars we could not drain
    } finally {
      try {
        db?.close();
      } catch {
        /* already closed */
      }
    }
    try {
      if (fs.statSync(walPath).size > 0) return;
    } catch {
      /* checkpoint removed it */
    }
  }

  for (const suffix of ["-wal", "-shm"]) {
    try {
      fs.unlinkSync(target + suffix);
    } catch {
      /* ignore */
    }
  }
}

/** Mirrors openDb() in db-query-worker.ts — retry read-write to rebuild -shm. */
function openDbWithRetry(target: string, readOnly: boolean): DatabaseSync {
  try {
    return new DatabaseSync(target, { readOnly });
  } catch (err) {
    const message = (err as Error).message ?? "";
    const code = (err as { code?: string }).code ?? "";
    const recoverable =
      readOnly &&
      (code.includes("SQLITE_IOERR") ||
        code.includes("SQLITE_CANTOPEN") ||
        code.includes("SQLITE_READONLY") ||
        /disk i\/o error|unable to open/i.test(message));
    if (!recoverable) throw err;
    return new DatabaseSync(target, { readOnly: false });
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wal-sidecar-"));
  dbPath = path.join(dir, "data.db");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("WAL sidecar cleanup preserves committed rows", () => {
  it("keeps every row when sidecars are cleaned after a WAL write", () => {
    seedWalDb(500);
    expect(fs.statSync(dbPath + "-wal").size).toBeGreaterThan(0);

    safeCleanupSidecars(dbPath);

    // The regression: unlinking a non-empty -wal dropped these rows.
    expect(countInvestors(false)).toBe(500);
    expect(fs.existsSync(dbPath + "-wal")).toBe(false);
  });

  it("leaves the database readable read-only after cleanup", () => {
    seedWalDb(120);
    safeCleanupSidecars(dbPath);

    // Read-only is the path mini-apps use via /api/db/query.
    expect(countInvestors(true)).toBe(120);
  });

  it("demonstrates the old unlink-only cleanup loses committed rows", () => {
    seedWalDb(500);

    // The pre-fix behaviour, reproduced exactly.
    for (const suffix of ["-wal", "-shm"]) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        /* ignore */
      }
    }

    // Data is gone — this is what the user saw as an empty Investors tab.
    // In practice the loss is total: the CREATE TABLE itself lived in the WAL,
    // so the table disappears rather than merely losing rows.
    let survived: number;
    try {
      survived = countInvestors(false);
    } catch {
      survived = 0; // table no longer exists
    }
    expect(survived).toBeLessThan(500);
  });

  it("does not delete sidecars it could not drain", () => {
    seedWalDb(300);
    // Hold an open connection so the checkpoint cannot fully truncate.
    const holder = new DatabaseSync(dbPath);
    holder.exec("BEGIN IMMEDIATE");
    try {
      safeCleanupSidecars(dbPath);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    // Whatever happened, the rows must survive.
    expect(countInvestors(false)).toBe(300);
  });
});

describe("read-only open survives a missing -shm sidecar", () => {
  it("recovers via read-write retry instead of throwing SQLITE_IOERR", () => {
    seedWalDb(80);

    // Simulate backup tooling copying data.db + -wal but not -shm.
    try {
      fs.unlinkSync(dbPath + "-shm");
    } catch {
      /* may not exist */
    }

    const db = openDbWithRetry(dbPath, true);
    try {
      const row = db.prepare("SELECT count(*) AS c FROM investors").get() as { c: number };
      expect(Number(row.c)).toBe(80);
    } finally {
      db.close();
    }
  });

  it("still propagates genuine corruption rather than masking it", () => {
    fs.writeFileSync(dbPath, "this is definitely not a sqlite database");
    expect(() => {
      const db = openDbWithRetry(dbPath, true);
      try {
        db.prepare("SELECT count(*) AS c FROM investors").get();
      } finally {
        db.close();
      }
    }).toThrow();
  });
});
