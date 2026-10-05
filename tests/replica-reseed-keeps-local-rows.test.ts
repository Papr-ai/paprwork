/**
 * A re-seed from cloud must not drop rows that were written locally but never pushed.
 *
 * Regression: a parked replica (engine aborts on a damaged data.db) was repaired with
 * `repair_cloud_sync pull`, which escalates to reseedTursoReplicaFromRemote after three
 * failed bootstraps. The re-seed deleted data.db and the marker snapshot (VACUUM INTO had
 * already failed on the damaged file, leaving 0 bytes) and replayed nothing — three
 * onboarding rows and a config edit vanished silently.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  replayLocalOnlyRows,
  salvageRowsInto,
  type LiveReplica,
  type SqlHandle,
} from "../src/gateway/services/tursoReplica/tursoReplicaReseedSalvage.js";
import {
  resetParkHealAttemptsForTests,
  scheduleParkedReplicaReseed,
} from "../src/gateway/services/tursoReplica/tursoReplicaParkHeal.js";

const nodeRequire = createRequire(import.meta.url);
type Ctor = new (location: string) => SqlHandle;
const DatabaseSync: Ctor | null = (() => {
  try {
    return (nodeRequire("node:sqlite") as { DatabaseSync: Ctor }).DatabaseSync;
  } catch {
    return null;
  }
})();

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCHEMA = `
  CREATE TABLE investors (id TEXT PRIMARY KEY, name TEXT, _papr_updated_at TEXT);
  CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT, _papr_updated_at TEXT);
  CREATE TABLE notes (body TEXT);
  CREATE TABLE _papr_sync_mute (id INTEGER PRIMARY KEY, depth INTEGER);
`;

function liveFrom(db: SqlHandle): LiveReplica & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    query: async (sql, params = []) => db.prepare(sql).all(...params) as Array<Record<string, unknown>>,
    write: async (statements) => {
      for (const s of statements) {
        writes.push(s.sql);
        db.prepare(s.sql).run(...s.params);
      }
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "reseed-salvage-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!DatabaseSync)("replayLocalOnlyRows", () => {
  it("writes only local-only rows and newer local versions; cloud keeps the rest", async () => {
    const snap = new DatabaseSync!(":memory:");
    const live = new DatabaseSync!(":memory:");
    snap.exec(SCHEMA);
    live.exec(SCHEMA);
    live.exec(`
      INSERT INTO investors VALUES ('a','A cloud','2026-10-01 00:00:00'), ('b','B cloud','2026-10-03 00:00:00');
      INSERT INTO config VALUES ('vercel_url','old','2026-09-01 00:00:00');
    `);
    snap.exec(`
      INSERT INTO investors VALUES ('a','A local newer','2026-10-04 00:00:00'),
        ('b','B local older','2026-10-02 00:00:00'), ('c','C local only','2026-10-04 15:15:31');
      INSERT INTO config VALUES ('vercel_url','https://dataroom.papr.ai','2026-10-04 15:18:37');
      INSERT INTO notes VALUES ('no primary key');
      INSERT INTO _papr_sync_mute VALUES (1, 0);
    `);

    const access = liveFrom(live);
    const result = await replayLocalOnlyRows(snap, access);

    expect(result).toMatchObject({ inserted: 1, updated: 2, tables: 2 });
    expect(result.skipped).toContain("notes");
    const rows = live.prepare("SELECT id, name, _papr_updated_at FROM investors ORDER BY id").all();
    expect(rows).toEqual([
      { id: "a", name: "A local newer", _papr_updated_at: "2026-10-04 00:00:00" },
      { id: "b", name: "B cloud", _papr_updated_at: "2026-10-03 00:00:00" },
      { id: "c", name: "C local only", _papr_updated_at: "2026-10-04 15:15:31" },
    ]);
    expect(live.prepare("SELECT value FROM config").all()).toEqual([
      { value: "https://dataroom.papr.ai" },
    ]);
    // Sync-managed tables are never replayed.
    expect(access.writes.some((w) => w.includes("_papr_sync_mute"))).toBe(false);
  });

  it("skips tables the cloud schema no longer has", async () => {
    const snap = new DatabaseSync!(":memory:");
    const live = new DatabaseSync!(":memory:");
    snap.exec("CREATE TABLE dropped (id TEXT PRIMARY KEY); INSERT INTO dropped VALUES ('x');");
    const result = await replayLocalOnlyRows(snap, liveFrom(live));
    expect(result.skipped).toEqual(["dropped"]);
    expect(result.inserted).toBe(0);
  });
});

describe.skipIf(!DatabaseSync)("salvageRowsInto", () => {
  it("falls back to a per-table copy when VACUUM INTO fails, skipping unreadable tables", () => {
    const real = new DatabaseSync!(":memory:");
    real.exec(SCHEMA);
    real.exec("INSERT INTO investors VALUES ('c','C','t'); INSERT INTO config VALUES ('k','v','t');");
    // Simulate a damaged file: VACUUM refuses the whole file, one table's pages are unreadable.
    const damaged: SqlHandle = {
      exec: (sql) => real.exec(sql),
      close: () => real.close(),
      prepare: (sql) => {
        if (/VACUUM INTO/i.test(sql) || /FROM "config"/.test(sql)) {
          throw new Error("database disk image is malformed");
        }
        return real.prepare(sql);
      },
    };
    const target = path.join(dir, "data.db-papr-reseed-salvage");
    const result = salvageRowsInto(damaged, target, (p) => new DatabaseSync!(p));

    expect(result.mode).toBe("per-table");
    expect(result.skipped).toEqual(["config"]);
    const out = new DatabaseSync!(target);
    expect(out.prepare("SELECT id FROM investors").all()).toEqual([{ id: "c" }]);
    out.close();
  });

  it("uses VACUUM INTO when the file is healthy", () => {
    const src = path.join(dir, "data.db");
    const db = new DatabaseSync!(src);
    db.exec(SCHEMA);
    db.exec("INSERT INTO investors VALUES ('c','C','t');");
    const target = `${src}-papr-reseed-salvage`;
    expect(salvageRowsInto(db, target, (p) => new DatabaseSync!(p)).mode).toBe("vacuum");
    db.close();
    expect(fs.statSync(target).size).toBeGreaterThan(0);
  });
});

describe("parked replica self-heal", () => {
  beforeEach(() => {
    resetParkHealAttemptsForTests();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  const record = { dbId: "db-1", localPath: "/x/data.db", tursoShortName: "j-1", syncMode: "replica" };

  it("re-seeds once per path per session when online", async () => {
    const reseed = vi.fn(async () => undefined);
    const deps = { isOnline: () => true, getRecord: () => record as never, reseed, delayMs: 0 };
    expect(await scheduleParkedReplicaReseed("/x/data.db", "aborted 3 times", deps)).toBe(true);
    expect(await scheduleParkedReplicaReseed("/x/data.db", "aborted 3 times", deps)).toBe(false);
    expect(reseed).toHaveBeenCalledTimes(1);
  });

  it("does not spend its attempt while offline", async () => {
    const reseed = vi.fn(async () => undefined);
    let online = false;
    const deps = { isOnline: () => online, getRecord: () => record as never, reseed, delayMs: 0 };
    expect(await scheduleParkedReplicaReseed("/x/data.db", "r", deps)).toBe(false);
    online = true;
    expect(await scheduleParkedReplicaReseed("/x/data.db", "r", deps)).toBe(true);
  });
});

describe("re-seed wiring", () => {
  const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");

  it("salvages before deleting and replays after provisioning", () => {
    const src = read("src/gateway/services/tursoReplica/tursoReplicaProvision.ts");
    const body = src.slice(src.indexOf("export async function reseedTursoReplicaFromRemote"));
    const salvage = body.indexOf("preserveLocalRowsForReseed(");
    const remove = body.indexOf("removeTursoReplicaLocalFiles(");
    const provision = body.indexOf("provisionTursoReplicaForRecord(");
    const replay = body.indexOf("replaySalvagedRows(");
    expect(salvage).toBeGreaterThan(-1);
    expect(salvage).toBeLessThan(remove);
    expect(provision).toBeLessThan(replay);
  });

  it("callers that switch primaries opt out of replay explicitly", () => {
    for (const file of [
      "src/gateway/services/cloudAppPerUserIsolation.ts",
      "src/gateway/services/tursoReplica/portableReplicaBootstrap.ts",
      "src/gateway/services/tursoReplica/PaprDbService.ts",
    ]) {
      expect(read(file)).toContain('reseedTursoReplicaFromRemote(record, { localRows: "discard" })');
    }
  });

  it("parking hands the path to the self-heal", () => {
    const src = read("src/gateway/services/tursoReplica/TursoReplicaSyncWorkerClient.ts");
    const park = src.slice(src.indexOf("private parkPath("));
    expect(park.slice(0, 800)).toContain("scheduleParkedReplicaReseed");
  });
});
