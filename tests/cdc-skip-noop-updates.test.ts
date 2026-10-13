/**
 * CDC update trigger must not log UPDATEs that rewrite a row with identical values.
 * Calendar Reader upserted ~3,600 unchanged events per hour; each one shipped to the
 * workspace log and replayed on Turso (~4M Turso row writes/day for 4MB of data).
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { rowChangedClause } from "../src/gateway/services/tursoSyncLog";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (p: string) => { exec(s: string): void; prepare(s: string): { get(): unknown } };
};

const cols = (names: string[]) => names.map((name, i) => ({ name, type: "TEXT", primaryKey: i === 0 })) as never;

describe("rowChangedClause", () => {
  it("compares user columns only, skipping _papr_* and touch-only stamps", () => {
    const c = rowChangedClause(cols(["id", "title", "updated_at", "_papr_row_version"]));
    expect(c).toBe(' AND (OLD."id" IS NOT NEW."id" OR OLD."title" IS NOT NEW."title")');
  });

  it("an unchanged upsert is not logged; a real change is", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE ev (id TEXT PRIMARY KEY, title TEXT, updated_at INTEGER, _papr_row_version INTEGER);
      CREATE TABLE log (pk TEXT);
      CREATE TRIGGER au AFTER UPDATE ON ev WHEN OLD._papr_row_version IS NEW._papr_row_version
        ${rowChangedClause(cols(["id", "title", "updated_at", "_papr_row_version"]))}
        BEGIN INSERT INTO log VALUES (NEW.id); END;
      INSERT INTO ev VALUES ('a', 'Dance', 1, 1);`);
    const upsert = (title: string, ts: number) =>
      db.exec(`INSERT INTO ev (id, title, updated_at) VALUES ('a', '${title}', ${ts})
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`);
    const logged = () => (db.prepare("SELECT COUNT(*) AS n FROM log").get() as { n: number }).n;
    upsert("Dance", 2);
    upsert("Dance", 3);
    expect(logged()).toBe(0);
    upsert("Dance 4:30", 4);
    expect(logged()).toBe(1);
  });
});
