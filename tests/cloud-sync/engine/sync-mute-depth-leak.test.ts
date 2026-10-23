/**
 * Regression tests for the leaked sync-mute depth that silently disables CDC.
 *
 * `_papr_sync_mute.depth` is a re-entrancy counter used by withSyncMuted() so
 * that sync's own writes don't get re-queued as user changes. Every CDC trigger
 * is guarded by `depth = 0`.
 *
 * The counter lives IN the database, but it only ever describes work inside a
 * live process. The decrement runs in a `finally` block — which never executes
 * if the process is killed or crashes mid-scope. The non-zero depth then
 * survives on disk forever, and every CDC trigger stays permanently disabled:
 *
 *   - local writes still succeed (the row really does change on disk)
 *   - nothing is queued in _papr_sync_log
 *   - the next cloud pull overwrites the row with the stale remote value
 *
 * To the user this reads as "my edits don't save" — they persist, then get
 * reverted by sync. Seen in production with depth = 129 on a data room where
 * investor stage changes kept reverting.
 *
 * Uses node:sqlite so this runs under plain vitest (the vendored better-sqlite3
 * targets Electron's ABI). The behaviour under test is the trigger guard and
 * the counter arithmetic, which are SQLite's own semantics.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "node:module";

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

const MUTE_GUARD =
  "(SELECT COALESCE((SELECT depth FROM \"_papr_sync_mute\" WHERE id = 1), 0)) = 0";

/** Mirrors the release statement in tursoSyncLog.ts (clamped at zero). */
const RELEASE_SQL =
  'UPDATE "_papr_sync_mute" SET depth = MAX(depth - 1, 0) WHERE id = 1';

const ACQUIRE_SQL = 'UPDATE "_papr_sync_mute" SET depth = depth + 1 WHERE id = 1';

function seedDb(): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE investors (id TEXT PRIMARY KEY, stage TEXT)");
  db.exec(
    "CREATE TABLE _papr_sync_log (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, op TEXT)",
  );
  db.exec(
    "CREATE TABLE _papr_sync_mute (id INTEGER PRIMARY KEY CHECK (id = 1), depth INTEGER NOT NULL DEFAULT 0)",
  );
  db.exec("INSERT OR IGNORE INTO _papr_sync_mute (id, depth) VALUES (1, 0)");
  db.exec(
    'CREATE TRIGGER "_papr_tr_investors_au" AFTER UPDATE ON "investors" ' +
      `WHEN ${MUTE_GUARD} ` +
      "BEGIN INSERT INTO _papr_sync_log (table_name, op) VALUES ('investors', 'update'); END",
  );
  db.exec("INSERT INTO investors (id, stage) VALUES ('inv-1', 'waiting')");
  return db;
}

/** Mirrors resetLeakedSyncMuteDepth() in tursoSyncLog.ts. */
function ensureInfrastructure(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT depth FROM _papr_sync_mute WHERE id = 1")
    .get() as { depth?: number } | undefined;
  const depth = Number(row?.depth ?? 0);
  if (Number.isFinite(depth) && depth !== 0) {
    db.exec("UPDATE _papr_sync_mute SET depth = 0 WHERE id = 1");
  }
  return depth;
}

function syncLogCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT count(*) AS c FROM _papr_sync_log").get() as {
    c: number;
  };
  return Number(row.c);
}

function muteDepth(db: DatabaseSync): number {
  const row = db.prepare("SELECT depth FROM _papr_sync_mute WHERE id = 1").get() as {
    depth: number;
  };
  return Number(row.depth);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-mute-"));
  dbPath = path.join(dir, "data.db");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a leaked mute depth disables CDC (the bug)", () => {
  it("stops queueing changes while depth > 0", () => {
    const db = seedDb();
    try {
      db.exec(ACQUIRE_SQL); // simulate a process that died before releasing
      db.exec("UPDATE investors SET stage='passed' WHERE id='inv-1'");

      // The row really did change...
      const row = db.prepare("SELECT stage FROM investors WHERE id='inv-1'").get() as {
        stage: string;
      };
      expect(row.stage).toBe("passed");
      // ...but nothing was queued for sync, so the cloud never learns about it.
      expect(syncLogCount(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("persists the leaked depth across connections", () => {
    let db = seedDb();
    db.exec(ACQUIRE_SQL);
    db.close();

    db = new DatabaseSync(dbPath);
    try {
      // Reopening does not clear it — this is why the bug is permanent.
      expect(muteDepth(db)).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("ensureLocalSyncInfrastructure clears a leaked depth (the fix)", () => {
  it("resets a stale depth and restores CDC", () => {
    let db = seedDb();
    db.exec(ACQUIRE_SQL);
    db.exec(ACQUIRE_SQL);
    db.exec(ACQUIRE_SQL); // depth = 3, leaked
    db.close();

    db = new DatabaseSync(dbPath);
    try {
      expect(ensureInfrastructure(db)).toBe(3); // observed the leak
      expect(muteDepth(db)).toBe(0);

      db.exec("UPDATE investors SET stage='closed' WHERE id='inv-1'");
      expect(syncLogCount(db)).toBe(1); // CDC works again
    } finally {
      db.close();
    }
  });

  it("leaves a healthy depth of 0 untouched", () => {
    const db = seedDb();
    try {
      expect(ensureInfrastructure(db)).toBe(0);
      db.exec("UPDATE investors SET stage='closed' WHERE id='inv-1'");
      expect(syncLogCount(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  it("does not clear a mute that is genuinely held in-process", () => {
    const db = seedDb();
    try {
      ensureInfrastructure(db); // startup check happens first
      db.exec(ACQUIRE_SQL); // real sync work begins after

      db.exec("UPDATE investors SET stage='passed' WHERE id='inv-1'");
      expect(syncLogCount(db)).toBe(0); // correctly muted

      db.exec(RELEASE_SQL);
      expect(muteDepth(db)).toBe(0);

      db.exec("UPDATE investors SET stage='closed' WHERE id='inv-1'");
      expect(syncLogCount(db)).toBe(1); // resumes after release
    } finally {
      db.close();
    }
  });
});

describe("mute release is clamped at zero", () => {
  it("never drives depth negative on an unbalanced release", () => {
    const db = seedDb();
    try {
      db.exec(RELEASE_SQL);
      db.exec(RELEASE_SQL);
      expect(muteDepth(db)).toBe(0);

      // A negative depth would also fail the `= 0` guard and break CDC.
      db.exec("UPDATE investors SET stage='passed' WHERE id='inv-1'");
      expect(syncLogCount(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  it("balances correctly through nested mutes", () => {
    const db = seedDb();
    try {
      db.exec(ACQUIRE_SQL);
      db.exec(ACQUIRE_SQL);
      db.exec(RELEASE_SQL);
      expect(muteDepth(db)).toBe(1);

      db.exec("UPDATE investors SET stage='passed' WHERE id='inv-1'");
      expect(syncLogCount(db)).toBe(0); // still muted by the outer scope

      db.exec(RELEASE_SQL);
      expect(muteDepth(db)).toBe(0);

      db.exec("UPDATE investors SET stage='closed' WHERE id='inv-1'");
      expect(syncLogCount(db)).toBe(1);
    } finally {
      db.close();
    }
  });
});
