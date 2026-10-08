/**
 * Turso Sync does not carry CREATE TRIGGER / CREATE VIEW to the cloud primary
 * (verified live, @tursodatabase/sync 0.7.2). A one-step migration
 * (applyRegistryMigrationSingleRoute) must copy them over after the push.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  droppedSchemaObjects,
  isPlatformSchemaObject,
  mirrorSchemaObjectsToCloud,
  mirrorStatements,
  planSchemaObjectMirror,
} from "../src/gateway/services/tursoReplica/tursoReplicaSchemaObjectMirror.js";
import { splitSqlStatements } from "../src/gateway/services/jobs/migrationSqlHelpers.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const LIST =
  "SELECT type, name, sql FROM sqlite_master WHERE type IN ('trigger','view') AND sql IS NOT NULL";

/** A node:sqlite db wearing the bits of the libsql Client the mirror uses. */
function fakeCloud(db: InstanceType<typeof DatabaseSync>) {
  return {
    execute: async (sql: string) => ({ rows: db.prepare(sql).all() as Record<string, unknown>[] }),
    batch: async (statements: string[]) => {
      db.exec("BEGIN");
      for (const s of statements) db.exec(s);
      db.exec("COMMIT");
      return [];
    },
    close: () => undefined,
  };
}

const MIGRATION = `CREATE TABLE c(id TEXT PRIMARY KEY, v INT);
CREATE TABLE log(id INTEGER PRIMARY KEY, cid TEXT);
CREATE TRIGGER trg_c AFTER UPDATE OF v ON c BEGIN INSERT OR IGNORE INTO log(id, cid) VALUES (NEW.v, NEW.id); END;
CREATE TRIGGER trg_plain AFTER INSERT ON c BEGIN INSERT INTO log(cid) VALUES (NEW.id); END;
CREATE VIEW vw AS SELECT id FROM c;`;

/** What sync leaves on the cloud: tables only. */
function syncedState() {
  const replica = new DatabaseSync(":memory:");
  for (const s of splitSqlStatements(MIGRATION)) replica.exec(s);
  replica.exec("CREATE TRIGGER _papr_tr_x_ai AFTER INSERT ON c BEGIN SELECT 1; END");
  const cloud = new DatabaseSync(":memory:");
  cloud.exec("CREATE TABLE c(id TEXT PRIMARY KEY, v INT); CREATE TABLE log(id INTEGER PRIMARY KEY, cid TEXT);");
  return { replica, cloud };
}

const deps = (replica: InstanceType<typeof DatabaseSync>, cloud: InstanceType<typeof DatabaseSync>) => ({
  readReplica: async () => replica.prepare(LIST).all() as Record<string, unknown>[],
  openCloud: async () => fakeCloud(cloud),
});
const source = { dbPath: "/x/data.db", dbId: "db-x" } as never;

describe("copy triggers/views to the cloud after a one-step migration", () => {
  it("creates the missing trigger and view; the trigger then fires on the cloud", async () => {
    const { replica, cloud } = syncedState();
    const out = await mirrorSchemaObjectsToCloud({ source, tursoDatabase: "d-x", statements: splitSqlStatements(MIGRATION), deps: deps(replica, cloud) });
    expect(out.error).toBeNull();
    expect(out.created.sort()).toEqual(["trigger trg_c", "view vw"]);
    // Plain INSERT trigger would double-write on the cloud: kept local, reported.
    expect(out.notCopied).toEqual(["trg_plain"]);
    cloud.exec("INSERT INTO c VALUES ('a', 0); UPDATE c SET v = 1 WHERE id = 'a';");
    expect(cloud.prepare("SELECT cid FROM log").all()).toEqual([{ cid: "a" }]);
    // Replayed device change fires it again: keyed INSERT OR IGNORE → still one row.
    cloud.exec("UPDATE c SET v = 1 WHERE id = 'a';");
    expect(cloud.prepare("SELECT count(*) n FROM log").get()).toEqual({ n: 1 });
  });

  it("skips platform triggers (_papr_*) and is a no-op the second time", async () => {
    const { replica, cloud } = syncedState();
    await mirrorSchemaObjectsToCloud({ source, tursoDatabase: "d-x", statements: [], deps: deps(replica, cloud) });
    const names = (cloud.prepare(LIST).all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).not.toContain("_papr_tr_x_ai");
    const again = await mirrorSchemaObjectsToCloud({ source, tursoDatabase: "d-x", statements: [], deps: deps(replica, cloud) });
    expect(again.created).toEqual([]);
  });

  it("replaces a trigger whose body changed and drops one the migration dropped", async () => {
    const { replica, cloud } = syncedState();
    cloud.exec("CREATE TRIGGER trg_c AFTER UPDATE OF v ON c BEGIN SELECT 0; END; CREATE TRIGGER trg_old AFTER INSERT ON c BEGIN SELECT 0; END;");
    const out = await mirrorSchemaObjectsToCloud({ source, tursoDatabase: "d-x", statements: ["DROP TRIGGER IF EXISTS trg_old"], deps: deps(replica, cloud) });
    expect(out.created).toContain("trigger trg_c");
    expect(out.dropped).toEqual(["trigger trg_old"]);
    const sql = (cloud.prepare("SELECT sql FROM sqlite_master WHERE name = 'trg_c'").get() as { sql: string }).sql;
    expect(sql).toMatch(/INSERT OR IGNORE INTO log/);
  });

  it("never throws — a cloud failure is reported", async () => {
    const out = await mirrorSchemaObjectsToCloud({
      source, tursoDatabase: "d-x", statements: [],
      deps: { readReplica: async () => [], openCloud: async () => { throw new Error("offline"); } },
    });
    expect(out.error).toBe("offline");
  });

  it("replay-safety check", async () => {
    const { isReplaySafeTrigger } = await import("../src/gateway/services/tursoReplica/tursoReplicaSchemaObjectMirror.js");
    const T = (body: string) => `CREATE TRIGGER t AFTER UPDATE ON c BEGIN ${body} END`;
    expect(isReplaySafeTrigger(T("INSERT OR IGNORE INTO l VALUES (NEW.id);"))).toBe(true);
    expect(isReplaySafeTrigger(T("INSERT INTO l VALUES (NEW.id) ON CONFLICT(id) DO NOTHING;"))).toBe(true);
    expect(isReplaySafeTrigger(T("UPDATE c SET rev = NEW.rev WHERE id = NEW.id;"))).toBe(true);
    expect(isReplaySafeTrigger(T("INSERT INTO l VALUES (NEW.id);"))).toBe(false);
    expect(isReplaySafeTrigger(T("UPDATE s SET n = n + 1;"))).toBe(false);
    expect(isReplaySafeTrigger(T("SELECT RAISE(ABORT, 'no; INSERT INTO x');"))).toBe(true);
  });

  it("helpers", () => {
    expect(isPlatformSchemaObject("_papr_tr_a")).toBe(true);
    expect(isPlatformSchemaObject("trg_c")).toBe(false);
    expect(droppedSchemaObjects(['DROP VIEW "my view"', "DROP TABLE t"])).toEqual([{ type: "view", name: "my view" }]);
    const plan = planSchemaObjectMirror(
      [{ type: "trigger", name: "t", sql: "CREATE TRIGGER t" }, { type: "view", name: "v", sql: "CREATE VIEW v" }],
      [], [],
    );
    expect(mirrorStatements(plan)[1]).toBe("CREATE VIEW v");
  });
});

describe("single-route migration wires the mirror after a successful push", () => {
  it("source calls mirrorSchemaObjectsToCloud only when pushed", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/gateway/services/tursoReplica/tursoReplicaMigrationDualApply.ts", "utf8");
    expect(src).toMatch(/if \(pushed\) \{\s*\/\/ Sync does not carry triggers\/views[\s\S]*mirrorSchemaObjectsToCloud/);
  });
});

describe("delete_database removes the cloud copy by default", () => {
  it("deleteTurso defaults to true and reports a cloud copy it could not delete", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/core/tools/databases.ts", "utf8");
    expect(src).toMatch(/args\.deleteTurso !== false/);
    expect(src).toMatch(/cloudNote/);
  });
});
