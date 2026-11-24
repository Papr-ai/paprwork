/**
 * A re-bootstrap must not settle onto a cloud copy whose schema lost keys/types.
 *
 * Regression: a cloud job rewrote every remote table as all-TEXT with no PRIMARY KEY. After an
 * engine panic the replica re-seeded from it, the marker cleared, the snapshot was deleted and
 * the app went blank. Replaying onto a keyless table would also have duplicated every row.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// better-sqlite3 here is built for Electron's ABI; stand in node:sqlite with the small
// surface the code under test uses (prepare().run/all/get, exec, close).
vi.mock("better-sqlite3", () => {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => {
      prepare(sql: string): { run(...a: unknown[]): { changes: number | bigint }; all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown };
      exec(sql: string): void;
      close(): void;
    };
  };
  class Shim {
    private db;
    open = true;
    inTransaction = false;
    constructor(file: string, opts?: { readonly?: boolean }) {
      this.db = new DatabaseSync(file, { readOnly: Boolean(opts?.readonly) });
    }
    prepare(sql: string) {
      const stmt = this.db.prepare(sql);
      return {
        run: (...a: unknown[]) => {
          const r = stmt.run(...a);
          return { changes: Number(r.changes) };
        },
        all: (...a: unknown[]) => stmt.all(...a),
        get: (...a: unknown[]) => stmt.get(...a),
      };
    }
    exec(sql: string) {
      this.db.exec(sql);
    }
    close() {
      this.open = false;
      this.db.close();
    }
  }
  return { default: Shim };
});

const Database = (await import("better-sqlite3")).default as unknown as new (
  p: string,
  o?: { readonly?: boolean },
) => {
  prepare(sql: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown };
  exec(sql: string): void;
  close(): void;
};
import { replayBootstrapSnapshot } from "../../../src/gateway/services/tursoReplica/tursoReplicaBootstrapReplay.js";
import {
  describeSchemaDegradation,
  detectSchemaDegradation,
} from "../../../src/gateway/services/tursoReplica/tursoReplicaSchemaDegradation.js";

const TYPED = `
  CREATE TABLE meetings (id INTEGER PRIMARY KEY AUTOINCREMENT, standup_id INTEGER NOT NULL,
                         started_at TEXT);
  CREATE TABLE turso_sync_last_change_id (client_id TEXT PRIMARY KEY, pull_gen INTEGER);
  INSERT INTO meetings(standup_id, started_at) VALUES (1, '2026-10-07'), (1, '2026-10-08');
`;
const FLATTENED = `
  CREATE TABLE meetings ("id" TEXT, "standup_id" TEXT, "started_at" TEXT);
  CREATE TABLE turso_sync_last_change_id ("client_id" TEXT, "pull_gen" TEXT);
  INSERT INTO meetings VALUES ('1', '1', '2026-10-07'), ('2', '1', '2026-10-08');
`;

let dir: string;
const notOwned = () => false;

function makeDb(file: string, sql: string): string {
  const p = path.join(dir, file);
  const db = new Database(p);
  db.exec(sql);
  db.close();
  return p;
}

function count(p: string): number {
  const db = new Database(p, { readonly: true });
  try {
    return (db.prepare("SELECT count(*) AS n FROM meetings").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "reseed-degraded-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("re-bootstrap schema degradation guard", () => {
  it("detects lost PRIMARY KEY and INTEGER -> TEXT, ignoring engine tables", () => {
    const live = makeDb("live.db", FLATTENED);
    const snap = makeDb("snap.db", TYPED);
    const db = new Database(live);
    db.prepare("ATTACH DATABASE ? AS papr_snapshot").run(snap);
    const found = detectSchemaDegradation(db as never, "papr_snapshot");
    db.close();

    expect(found).toEqual([
      { table: "meetings", lostPrimaryKey: ["id"], lostTypes: ["id", "standup_id"] },
    ]);
    expect(describeSchemaDegradation(found)).toContain("meetings: lost PRIMARY KEY (id)");
  });

  it("refuses to replay onto a flattened schema instead of duplicating rows", () => {
    const live = makeDb("live.db", FLATTENED);
    const snap = makeDb("snap.db", TYPED);

    const result = replayBootstrapSnapshot(live, snap, notOwned);

    expect(result.degraded?.map((d) => d.table)).toEqual(["meetings"]);
    expect(result.rowsReplayed).toBe(0);
    expect(count(live)).toBe(2); // not 4 — keyless INSERT OR REPLACE would append
    expect(fs.existsSync(snap)).toBe(true);
  });

  it("still replays normally when the bootstrapped schema matches", () => {
    const live = makeDb("live.db", TYPED);
    const snap = makeDb(
      "snap.db",
      TYPED + "INSERT INTO meetings(standup_id, started_at) VALUES (1, '2026-10-09');",
    );

    const result = replayBootstrapSnapshot(live, snap, notOwned);

    expect(result.degraded).toBeUndefined();
    expect(count(live)).toBe(3);
  });

  it("does not flag a column that was already TEXT or a newly added column", () => {
    const live = makeDb(
      "live.db",
      TYPED.replace("started_at TEXT)", "started_at TEXT, notes TEXT)"),
    );
    const snap = makeDb("snap.db", TYPED);
    const db = new Database(live);
    db.prepare("ATTACH DATABASE ? AS papr_snapshot").run(snap);
    expect(detectSchemaDegradation(db as never, "papr_snapshot")).toEqual([]);
    db.close();
  });
});
